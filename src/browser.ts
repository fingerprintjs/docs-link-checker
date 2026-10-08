// Pages of the shared browser of the run as scoped resources (closed when the scope ends), with blocking of heavy
// resources and a relaunch after a browser crash. https://effect.website/docs/resource-management/scope/
import { Data, Effect } from "effect";
import type { Browser, Page, Request, Route } from "playwright";
import { BrowserSlot } from "./run";
import { type BrowserLaunchError, getErrorMessage } from "./utils/errors";

// How many Playwright pages (browser contexts) are open at the same time
export const PLAYWRIGHT_CONCURRENCY_LIMIT = 5;

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

/** A Playwright call failed (navigation error, closed page, crashed browser...) */
export class PageError extends Data.TaggedError("PageError")<{
  readonly cause: unknown;
}> {
  override get message() {
    return getErrorMessage(this.cause);
  }

  // Reports show the same text as the original Playwright error ("Error: page.goto: ...")
  override toString() {
    return String(this.cause);
  }
}

/** Runs a Playwright call, its failure is a `PageError` */
export const tryPage = <A>(fn: () => Promise<A>) =>
  Effect.tryPromise({ try: fn, catch: (cause) => new PageError({ cause }) });

// Global, not per run: a process has one set of CPU cores for pages
const pageSlots = Effect.unsafeMakeSemaphore(PLAYWRIGHT_CONCURRENCY_LIMIT);

type WithPageOptions = {
  userAgent?: string;
  /** Timeout of every page operation (navigation, wait...), so each check is bounded on its own */
  timeout: number;
};

/** A page in its own browser context, closed when the scope ends */
const acquirePage = (browser: Browser, { userAgent, timeout }: WithPageOptions) =>
  Effect.gen(function* () {
    const context = yield* Effect.acquireRelease(
      tryPage(() => browser.newContext({ userAgent })),
      (opened) => Effect.promise(() => opened.close().catch(() => {})),
    );
    // One blocker per context: it tracks the URL of this context's page
    const blocker = createResourceBlocker();
    yield* tryPage(() => context.route("**/*", (route) => blocker(route)));
    const page = yield* tryPage(() => context.newPage());
    // Response bodies have no Playwright timeout, callers bound them (see `readResponseText` in playwright_check.ts)
    page.setDefaultTimeout(timeout);
    page.setDefaultNavigationTimeout(timeout);
    return page;
  });

/**
 * Runs `use` with a fresh page (in its own browser context) of the shared browser of the run.
 * - At most `PLAYWRIGHT_CONCURRENCY_LIMIT` pages are open at the same time.
 * - Heavy resources (images, media, fonts, analytics) are blocked.
 * - The context is closed when `use` ends, fails or is interrupted.
 * - If the browser crashed (`use` or opening the page failed and the browser is disconnected), it is relaunched and
 *   `use` is run once more.
 */
export const withPage = <A, E, R>(
  use: (page: Page) => Effect.Effect<A, E, R>,
  options: WithPageOptions,
): Effect.Effect<A, E | PageError | BrowserLaunchError, R | BrowserSlot> =>
  pageSlots.withPermits(1)(attempt(use, options, true));

const attempt = <A, E, R>(
  use: (page: Page) => Effect.Effect<A, E, R>,
  options: WithPageOptions,
  canRetry: boolean,
): Effect.Effect<A, E | PageError | BrowserLaunchError, R | BrowserSlot> =>
  Effect.gen(function* () {
    const slot = yield* BrowserSlot;
    const browser = yield* slot.get;
    return yield* Effect.scoped(Effect.flatMap(acquirePage(browser, options), use)).pipe(
      Effect.catchAll((error) =>
        canRetry && !browser.isConnected()
          ? Effect.zipRight(
              Effect.sync(() =>
                console.warn(
                  `Browser disconnected (${String(error)}), relaunching and retrying once...`,
                ),
              ),
              // Closes it and makes the next `get` launch a new one
              Effect.zipRight(slot.discard(browser), attempt(use, options, false)),
            )
          : Effect.fail(error),
      ),
    );
  });
