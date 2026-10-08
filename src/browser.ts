import pLimit from "p-limit";
import { type Browser, chromium, type Page, type Request, type Route } from "playwright";
import { getBrowserSlot, incrementMetric } from "./run";

// How many Playwright pages (browser contexts) are open at the same time
export const PLAYWRIGHT_CONCURRENCY_LIMIT = 5;

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

/** Decides if a request made by a page should be aborted */
const shouldBlockRequest = (
  request: Request,
  isMainFrame: boolean,
  pageUrl: string | undefined,
): boolean => {
  // The link being checked is never blocked
  if (isMainFrame) {
    return false;
  }
  // Images, media and fonts never add anchors, whoever hosts them
  if (BLOCKED_RESOURCE_TYPES.has(request.resourceType())) {
    return true;
  }
  const hostname = getHostname(request.url());
  if (hostname === undefined) {
    return false;
  }
  // If the page itself is hosted by a blocked vendor (e.g. segment.com docs), its own hosts are not blocked
  const pageHostname = getHostname(pageUrl);
  return BLOCKED_HOSTS.some(
    (host) =>
      matchesHost(hostname, host) &&
      !(pageHostname !== undefined && matchesHost(pageHostname, host)),
  );
};

const isMainFrameNavigation = (request: Request): boolean => {
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

/** Route handler for one browser context, remembers the latest main frame URL (including redirects) */
const createResourceBlocker = () => {
  let pageUrl: string | undefined;
  return async (route: Route) => {
    const request = route.request();
    const isMainFrame = isMainFrameNavigation(request);
    if (isMainFrame) {
      pageUrl = request.url();
    }
    const block = shouldBlockRequest(request, isMainFrame, pageUrl);
    // The page might already be closed, ignore errors
    await (block ? route.abort("blockedbyclient") : route.continue()).catch(() => {});
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
const getBrowser = (): Promise<Browser> => {
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
  /** Timeout of every page operation (navigation, wait...), so each check is bounded on its own */
  timeout: number;
};

const runWithNewPage = async <T>(
  browser: Browser,
  fn: (page: Page) => Promise<T>,
  { userAgent, timeout }: WithPageOptions,
) => {
  const context = await browser.newContext({ userAgent });
  try {
    // One blocker per context: it tracks the URL of this context's page
    const blocker = createResourceBlocker();
    await context.route("**/*", (route) => blocker(route));
    const page = await context.newPage();
    // Response bodies have no Playwright timeout, callers bound them (see `readResponseText` in playwright_check.ts)
    page.setDefaultTimeout(timeout);
    page.setDefaultNavigationTimeout(timeout);
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
  options: WithPageOptions,
): Promise<T> => pageSlots(() => withSharedBrowserPage(fn, options));

const withSharedBrowserPage = async <T>(
  fn: (page: Page) => Promise<T>,
  options: WithPageOptions,
): Promise<T> => {
  const slot = getBrowserSlot();
  for (let attempt = 0; ; attempt++) {
    const browser = await getBrowser();
    try {
      return await runWithNewPage(browser, fn, options);
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
