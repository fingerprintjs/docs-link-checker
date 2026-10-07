import pLimit from "p-limit";
import { type Browser, chromium, type Page, type Route } from "playwright";
import { isBlockedUrlLiteral } from "./destination";
import { getBrowserSlot, incrementMetric, isPrivateHostsAllowed } from "./run";

// How many Playwright pages (browser contexts) are open at the same time
export const PLAYWRIGHT_CONCURRENCY_LIMIT = 10;

// Timeout of every Playwright page operation (a navigation, a wait...), so each check is bounded on its own
export const PAGE_OPERATION_TIMEOUT = 30000;
// How long a hash is waited for after the page loaded (client-side rendered anchors)
export const HASH_WAIT_TIMEOUT = 3000;
// A hash still missing after HASH_WAIT_TIMEOUT is waited for longer, together with the other hashes of its page.
// This is the overall budget of the page, counted from the first check (HASH_WAIT_TIMEOUT included): a missing
// anchor takes all of it.
// E.g. Mintlify docs expand collapsed sections and add their ids several seconds after hydration.
export const HASH_FALLBACK_WAIT_TIMEOUT = 15000;

const LAUNCH_OPTIONS = {
  // Potentially helps avoid some bot detection checks
  args: ["--disable-blink-features=AutomationControlled"],
};

// Heavy resources that are never needed to check if a page (or an anchor on it) exists
const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font"]);

// Analytics, tag managers and ads: slow down the page and never add anchors
const BLOCKED_HOSTS = [
  "googletagmanager.com",
  "google-analytics.com",
  "analytics.google.com",
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "segment.com",
  "segment.io",
  "hotjar.com",
  "hotjar.io",
  "clarity.ms",
  "connect.facebook.net",
  "bat.bing.com",
  "snap.licdn.com",
  "px.ads.linkedin.com",
  "static.ads-twitter.com",
  "analytics.tiktok.com",
  "hs-analytics.net",
  "hs-scripts.com",
  "mixpanel.com",
  "amplitude.com",
  "heapanalytics.com",
  "fullstory.com",
  "plausible.io",
];

const matchesHost = (hostname: string, host: string) =>
  hostname === host || hostname.endsWith(`.${host}`);

const getHostname = (url: string | undefined): string | undefined => {
  if (!url) {
    return undefined;
  }
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
};

export type RequestInfo = {
  resourceType: string;
  url: string;
  /**
   * The top-level document navigation (the link being checked) is not blocked by resource type or vendor,
   * only by the destination policy
   */
  isMainFrameNavigation: boolean;
  /**
   * URL of the checked page (main frame). If the page itself is hosted by a blocked vendor (e.g. segment.com docs),
   * requests to that vendor's hosts are its own resources and are not blocked.
   */
  pageUrl?: string;
  /** Allow private and local destinations (`LINK_CHECK_ALLOW_PRIVATE_HOSTS`), default from the current run */
  allowPrivateHosts?: boolean;
};

/**
 * Decides if a request made by a page should be aborted (pure function, used by the Playwright route handler).
 */
export const shouldBlockRequest = ({
  resourceType,
  url,
  isMainFrameNavigation,
  pageUrl,
  allowPrivateHosts = isPrivateHostsAllowed(),
}: RequestInfo): boolean => {
  // SSRF guard for every request, including the main navigation and its redirects: IP literals and localhost
  // names only, no DNS resolution. Links only get here after the fetch pass, which also resolves host names.
  if (isBlockedUrlLiteral(url, allowPrivateHosts)) {
    return true;
  }
  if (isMainFrameNavigation) {
    return false;
  }
  // Images, media and fonts never add anchors, whoever hosts them
  if (BLOCKED_RESOURCE_TYPES.has(resourceType)) {
    return true;
  }
  const hostname = getHostname(url);
  if (hostname === undefined) {
    return false;
  }
  const pageHostname = getHostname(pageUrl);
  return BLOCKED_HOSTS.some(
    (host) =>
      matchesHost(hostname, host) &&
      !(pageHostname !== undefined && matchesHost(pageHostname, host)),
  );
};

const isMainFrameNavigation = (route: Route): boolean => {
  const request = route.request();
  if (!request.isNavigationRequest()) {
    return false;
  }
  try {
    return request.frame().parentFrame() === null;
  } catch {
    // Service worker requests have no frame
    return false;
  }
};

/**
 * Route handler blocking heavy resources of a page.
 * @param pageUrl URL of the checked page (see `RequestInfo.pageUrl`)
 */
export const blockHeavyResources = async (route: Route, pageUrl?: string) => {
  const request = route.request();
  const block = shouldBlockRequest({
    resourceType: request.resourceType(),
    url: request.url(),
    isMainFrameNavigation: isMainFrameNavigation(route),
    pageUrl,
  });
  // The page might already be closed, ignore errors
  await (block ? route.abort("blockedbyclient") : route.continue()).catch(() => {});
};

/**
 * Route handler for one browser context: remembers the URL of the latest main frame navigation
 * (including redirects), so the page's own resources are recognised.
 */
export const createResourceBlocker = () => {
  let pageUrl: string | undefined;
  return async (route: Route) => {
    if (isMainFrameNavigation(route)) {
      pageUrl = route.request().url();
    }
    await blockHeavyResources(route, pageUrl);
  };
};

const pageSlots = pLimit(PLAYWRIGHT_CONCURRENCY_LIMIT);

const launchBrowser = async (): Promise<Browser> => {
  incrementMetric("browserLaunches");
  return chromium.launch({ headless: true, ...LAUNCH_OPTIONS });
};

/**
 * Returns the shared browser of the current run (or the default context outside of any run), launching it on first
 * use. Concurrent callers share the same launch.
 */
export const getBrowser = (): Promise<Browser> => {
  const slot = getBrowserSlot();
  if (!slot.promise) {
    const promise = launchBrowser().then(
      (browser) => {
        if (slot.promise === promise) {
          slot.browser = browser;
        }
        return browser;
      },
      (error) => {
        // Launch failed, try again next time
        if (slot.promise === promise) {
          slot.promise = undefined;
        }
        throw error;
      },
    );
    slot.promise = promise;
  }
  return slot.promise;
};

/** Forgets `browser` if it is still the current one of its slot (so the next check launches a new one) */
const forgetBrowser = (slot: ReturnType<typeof getBrowserSlot>, browser: Browser) => {
  if (slot.browser === browser) {
    slot.browser = undefined;
    slot.promise = undefined;
  }
};

type WithPageOptions = {
  userAgent?: string;
};

const runWithNewPage = async <T>(
  browser: Browser,
  fn: (page: Page) => Promise<T>,
  userAgent?: string,
) => {
  const context = await browser.newContext({ userAgent });
  try {
    // One blocker per context: it tracks the URL of this context's page
    const blocker = createResourceBlocker();
    await context.route("**/*", (route) => blocker(route));
    const page = await context.newPage();
    // Every page operation is bounded (navigations, waits...), even if a caller passes no timeout. Response bodies have
    // no Playwright timeout, callers bound them (see `readResponseText` in link.ts)
    page.setDefaultTimeout(PAGE_OPERATION_TIMEOUT);
    page.setDefaultNavigationTimeout(PAGE_OPERATION_TIMEOUT);
    return await fn(page);
  } finally {
    await context.close().catch(() => {});
  }
};

/**
 * Runs `fn` with a fresh page (in its own browser context) of the shared browser.
 * At most `PLAYWRIGHT_CONCURRENCY_LIMIT` pages are open at the same time.
 * Heavy resources (images, media, fonts, analytics) are blocked.
 * If the browser crashed, it is relaunched and `fn` is retried once.
 */
export const withPage = async <T>(
  fn: (page: Page) => Promise<T>,
  { userAgent }: WithPageOptions = {},
): Promise<T> => pageSlots(() => withSharedBrowserPage(fn, userAgent));

const withSharedBrowserPage = async <T>(
  fn: (page: Page) => Promise<T>,
  userAgent?: string,
): Promise<T> => {
  const slot = getBrowserSlot();
  for (let attempt = 0; ; attempt++) {
    const browser = await getBrowser();
    try {
      return await runWithNewPage(browser, fn, userAgent);
    } catch (error) {
      if (attempt === 0 && !browser.isConnected()) {
        console.warn(`Browser disconnected (${String(error)}), relaunching and retrying once...`);
        forgetBrowser(slot, browser);
        await browser.close().catch(() => {});
        continue;
      }
      throw error;
    }
  }
};
