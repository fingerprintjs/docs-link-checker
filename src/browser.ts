import { chromium, Browser, Page, Route } from "playwright";
import { Semaphore } from "./limiter";
import { incrementMetric } from "./run_context";
import { PLAYWRIGHT_CONCURRENCY_LIMIT } from "./utils";

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

const isBlockedHost = (hostname: string) =>
  BLOCKED_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));

export type RequestInfo = {
  resourceType: string;
  url: string;
  /** The top-level document navigation (the link being checked) is never blocked */
  isMainFrameNavigation: boolean;
};

/**
 * Decides if a request made by a page should be aborted (pure function, used by the Playwright route handler).
 */
export const shouldBlockRequest = ({ resourceType, url, isMainFrameNavigation }: RequestInfo): boolean => {
  if (isMainFrameNavigation) {
    return false;
  }
  if (BLOCKED_RESOURCE_TYPES.has(resourceType)) {
    return true;
  }
  try {
    return isBlockedHost(new URL(url).hostname);
  } catch {
    return false;
  }
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

export const blockHeavyResources = async (route: Route) => {
  const request = route.request();
  const block = shouldBlockRequest({
    resourceType: request.resourceType(),
    url: request.url(),
    isMainFrameNavigation: isMainFrameNavigation(route),
  });
  // The page might already be closed, ignore errors
  await (block ? route.abort("blockedbyclient") : route.continue()).catch(() => {});
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
      }
    );
    browserPromise = promise;
  }
  return browserPromise;
};

/**
 * Closes the shared browser (if it was launched). Safe to call multiple times.
 * Called at the end of every run, call it yourself if you use `checkLinkWithPlaywright` outside of a run.
 */
export const closeBrowser = async (): Promise<void> => {
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

type WithPageOptions = {
  userAgent?: string;
  /** `false` launches a separate visible browser that is left open for debugging */
  headless?: boolean;
};

const runWithNewPage = async <T>(browser: Browser, fn: (page: Page) => Promise<T>, userAgent?: string) => {
  const context = await browser.newContext({ userAgent });
  try {
    await context.route("**/*", blockHeavyResources);
    const page = await context.newPage();
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
export const withPage = <T>(fn: (page: Page) => Promise<T>, { userAgent, headless = true }: WithPageOptions = {}) =>
  pageSlots.run(async () => {
    if (!headless) {
      const browser = await chromium.launch({ headless: false, ...LAUNCH_OPTIONS });
      return runWithNewPage(browser, fn, userAgent);
    }

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
  });
