import { chromium, Browser, Page, Route } from "playwright";
import { Semaphore } from "./limiter";
import { incrementMetric } from "./run_context";
import { PLAYWRIGHT_CONCURRENCY_LIMIT } from "./utils";

// Timeout of every Playwright page operation (a navigation, a wait...), so each check is bounded on its own
export const PAGE_OPERATION_TIMEOUT = 30000;
// How long a hash is waited for after the page loaded (client-side rendered anchors)
export const HASH_WAIT_TIMEOUT = 3000;

const LAUNCH_OPTIONS = {
  // Potentially helps avoid some bot detection checks
  args: ["--disable-blink-features=AutomationControlled"],
};

// Heavy resources that are never needed to check if a page (or an anchor on it) exists
const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font"]);

// Analytics, tag managers and ads: slow down the page and never add anchors
export const BLOCKED_HOSTS = [
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

const matchesHost = (hostname: string, host: string) => hostname === host || hostname.endsWith(`.${host}`);

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
  /** The top-level document navigation (the link being checked) is never blocked */
  isMainFrameNavigation: boolean;
  /**
   * URL of the checked page (main frame). If the page itself is hosted by a blocked vendor (e.g. segment.com docs),
   * requests to that vendor's hosts are its own resources and are not blocked.
   */
  pageUrl?: string;
};

/**
 * Decides if a request made by a page should be aborted (pure function, used by the Playwright route handler).
 */
export const shouldBlockRequest = ({ resourceType, url, isMainFrameNavigation, pageUrl }: RequestInfo): boolean => {
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
    (host) => matchesHost(hostname, host) && !(pageHostname !== undefined && matchesHost(pageHostname, host)),
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

let browserPromise: Promise<Browser> | undefined;
// The resolved shared browser (set once the launch finishes)
let currentBrowser: Browser | undefined;
const pageSlots = new Semaphore(PLAYWRIGHT_CONCURRENCY_LIMIT);

const launchBrowser = async (): Promise<Browser> => {
  incrementMetric("browserLaunches");
  const browser = await chromium.launch({ headless: true, ...LAUNCH_OPTIONS });
  browser.on("disconnected", () => forgetBrowser(browser));
  return browser;
};

/** Forgets the shared browser if it is `browser` (so the next check launches a new one) */
const forgetBrowser = (browser: Browser) => {
  if (currentBrowser === browser) {
    currentBrowser = undefined;
    browserPromise = undefined;
  }
};

/**
 * Returns the shared browser, launching it on first use. Concurrent callers share the same launch.
 */
export const getBrowser = (): Promise<Browser> => {
  if (!browserPromise) {
    const promise = launchBrowser().then(
      (browser) => {
        if (browserPromise === promise) {
          currentBrowser = browser;
        }
        return browser;
      },
      (error) => {
        // Launch failed, try again next time
        if (browserPromise === promise) {
          browserPromise = undefined;
        }
        throw error;
      },
    );
    browserPromise = promise;
  }
  return browserPromise;
};

// Visible browsers launched for debugging (`headless: false`), left open for inspection until `closeBrowser()`
const debugBrowsers = new Set<Browser>();

/**
 * Closes the shared browser and any visible debug browsers (`headless: false`). Safe to call multiple times.
 * Call it yourself if you use `checkLinkWithPlaywright` outside of a run. Runs only close the shared browser
 * (see `endBrowserRun`), debug browsers stay open until this is called or the process exits
 * (Playwright closes the browsers it launched when the process exits).
 */
export const closeBrowser = async (): Promise<void> => {
  const debug = [...debugBrowsers];
  debugBrowsers.clear();
  await Promise.all([closeSharedBrowser(), ...debug.map((browser) => browser.close().catch(() => {}))]);
};

/** Closes the shared (headless) browser, if it was launched */
const closeSharedBrowser = async (): Promise<void> => {
  const promise = browserPromise;
  browserPromise = undefined;
  currentBrowser = undefined;
  if (!promise) {
    return;
  }
  try {
    const browser = await promise;
    await browser.close();
  } catch {
    // Launch failed or the browser is already gone
  }
};

// Outer runs currently active (see `withRun`) and shared-browser page leases (`withPage` calls, also outside of runs,
// counted while waiting for a page slot too). The shared browser is closed only when both reach zero.
let activeRuns = 0;
let activeLeases = 0;

const closeSharedBrowserIfIdle = async () => {
  if (activeRuns === 0 && activeLeases === 0) {
    await closeSharedBrowser();
  }
};

/** Marks the start of an outer run that may use the shared browser, pair it with `endBrowserRun` */
export const beginBrowserRun = () => {
  activeRuns++;
};

/**
 * Ends an outer run: closes the shared browser if no other run is still active (concurrent runs share it)
 * and no page is still in use (e.g. a standalone check outside of any run).
 * Visible debug browsers are kept open for inspection (see `closeBrowser`).
 */
export const endBrowserRun = async () => {
  activeRuns = Math.max(0, activeRuns - 1);
  await closeSharedBrowserIfIdle();
};

type WithPageOptions = {
  userAgent?: string;
  /**
   * `false` launches a separate visible browser for debugging: its page is left open for inspection after the check,
   * until `closeBrowser()` is called or the process exits
   */
  headless?: boolean;
};

const runWithNewPage = async <T>(
  browser: Browser,
  fn: (page: Page) => Promise<T>,
  userAgent?: string,
  keepOpen = false,
) => {
  const context = await browser.newContext({ userAgent });
  try {
    // One blocker per context: it tracks the URL of this context's page
    const blocker = createResourceBlocker();
    await context.route("**/*", (route) => blocker(route));
    const page = await context.newPage();
    // Every page operation is bounded (navigations, waits, reading responses...), even if a caller passes no timeout
    page.setDefaultTimeout(PAGE_OPERATION_TIMEOUT);
    page.setDefaultNavigationTimeout(PAGE_OPERATION_TIMEOUT);
    return await fn(page);
  } finally {
    if (!keepOpen) {
      await context.close().catch(() => {});
    }
  }
};

/**
 * Runs `fn` with a fresh page (in its own browser context) of the shared browser.
 * At most `PLAYWRIGHT_CONCURRENCY_LIMIT` pages are open at the same time.
 * Heavy resources (images, media, fonts, analytics) are blocked.
 * If the browser crashed, it is relaunched and `fn` is retried once.
 * Every call holds a lease on the shared browser (from before it waits for a page slot until it is done), so no run
 * ending in the meantime closes it. A call outside of any run closes the shared browser when it is the last user.
 */
export const withPage = async <T>(
  fn: (page: Page) => Promise<T>,
  { userAgent, headless = true }: WithPageOptions = {},
): Promise<T> => {
  if (!headless) {
    return pageSlots.run(async () => {
      const browser = await chromium.launch({ headless: false, ...LAUNCH_OPTIONS });
      // Tracked so `closeBrowser()` closes it, the page stays open for inspection until then
      debugBrowsers.add(browser);
      browser.on("disconnected", () => debugBrowsers.delete(browser));
      return runWithNewPage(browser, fn, userAgent, true);
    });
  }

  activeLeases++;
  try {
    return await pageSlots.run(() => withSharedBrowserPage(fn, userAgent));
  } finally {
    activeLeases--;
    await closeSharedBrowserIfIdle();
  }
};

const withSharedBrowserPage = async <T>(fn: (page: Page) => Promise<T>, userAgent?: string): Promise<T> => {
  for (let attempt = 0; ; attempt++) {
    const browser = await getBrowser();
    try {
      return await runWithNewPage(browser, fn, userAgent);
    } catch (error) {
      if (attempt === 0 && !browser.isConnected()) {
        console.warn(`Browser disconnected (${String(error)}), relaunching and retrying once...`);
        forgetBrowser(browser);
        await browser.close().catch(() => {});
        continue;
      }
      throw error;
    }
  }
};
