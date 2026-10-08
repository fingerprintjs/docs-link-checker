/**
 * Shared Chromium for the Playwright re-checks: lazy launch, page slots, crash retry.
 * - https://playwright.dev/docs/api/class-browsertype
 * - https://effect.website/docs/resource-management/scope/
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Cause, Context, Duration, Effect, Exit, Layer, RcRef, Ref, type Scope } from "effect";
import {
  type Browser as PlaywrightBrowser,
  type BrowserType,
  chromium,
  type Page,
  type Request,
  type Route,
} from "playwright";
import { BrowserLaunchError, getErrorMessage, PlaywrightError } from "./errors";
import { Metrics } from "./metrics";

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

/** Downloads Chromium with this package's `playwright` CLI, not a different version from `npx playwright` */
const installChromium = Effect.gen(function* () {
  const cli = join(
    dirname(createRequire(import.meta.url).resolve("playwright/package.json")),
    "cli.js",
  );
  const result = yield* Effect.try({
    try: () => spawnSync(process.execPath, [cli, "install", "chromium"], { stdio: "inherit" }),
    catch: (cause) => new BrowserLaunchError({ cause }),
  });
  if (result.status !== 0) {
    return yield* new BrowserLaunchError({
      cause:
        result.error ?? new Error(`playwright install chromium failed (exit ${result.status})`),
    });
  }
});

/** The only place `chromium` is used (launch, install). Faked in tests instead of mocking modules. */
export class Chromium extends Context.Tag("Chromium")<
  Chromium,
  {
    readonly launch: BrowserType["launch"];
    readonly install: Effect.Effect<void, BrowserLaunchError>;
  }
>() {
  static readonly layer: Layer.Layer<Chromium> = Layer.succeed(Chromium, {
    launch: (options) => chromium.launch(options),
    install: installChromium,
  });
}

/** Promise-returning Playwright call as an effect (the only place Playwright errors are caught) */
export const tryPlaywright = <A>(f: () => Promise<A>): Effect.Effect<A, PlaywrightError> =>
  Effect.tryPromise({ try: f, catch: (cause) => new PlaywrightError({ cause }) });

const isMissingBrowserExecutable = (error: BrowserLaunchError) =>
  error.cause instanceof Error && error.cause.message.includes("Executable doesn't exist");

const closeQuietly = (browser: PlaywrightBrowser) =>
  tryPlaywright(() => browser.close()).pipe(Effect.ignore);

/** A fresh context with one page, closed with the scope. Heavy resources and analytics are blocked. */
const openPage = (
  browser: PlaywrightBrowser,
  { userAgent, timeout }: { readonly userAgent?: string; readonly timeout: number },
): Effect.Effect<Page, PlaywrightError, Scope.Scope> =>
  Effect.gen(function* () {
    const context = yield* Effect.acquireRelease(
      tryPlaywright(() => browser.newContext({ userAgent })),
      (created) => tryPlaywright(() => created.close()).pipe(Effect.ignore),
    );
    // One blocker per context: it tracks the URL of this context's page
    const blocker = createResourceBlocker();
    yield* tryPlaywright(() => context.route("**/*", (route) => blocker(route)));
    const page = yield* tryPlaywright(() => context.newPage());
    // Response bodies have no Playwright timeout, callers bound them (see `readResponseText` in playwright_check.ts)
    page.setDefaultTimeout(timeout);
    page.setDefaultNavigationTimeout(timeout);
    return page;
  });

/** One try of `withPage`. `crash` is set when it failed and the browser is disconnected. */
type PageAttempt<A, E> = {
  readonly exit: Exit.Exit<A, E>;
  readonly crash: Cause.Cause<E> | undefined;
};

export class Browser extends Context.Tag("Browser")<
  Browser,
  {
    /**
     * Fresh page in its own context of the shared browser. At most `PLAYWRIGHT_CONCURRENCY_LIMIT` pages at a time.
     * Images, media, fonts and analytics are blocked. If the browser crashed (disconnected) it is relaunched and
     * `use` runs again once, then the original error surfaces.
     */
    readonly withPage: <A, E, R>(
      options: { readonly userAgent?: string; readonly timeout: number },
      use: (page: Page) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | BrowserLaunchError | PlaywrightError, R>;
  }
>() {
  /** The browser is launched by the first `withPage` and closed with the layer */
  static readonly layer: Layer.Layer<Browser, never, Chromium | Metrics> = Layer.scoped(
    Browser,
    Effect.gen(function* () {
      const { launch, install } = yield* Chromium;
      const metrics = yield* Metrics;
      const pageSlots = yield* Effect.makeSemaphore(PLAYWRIGHT_CONCURRENCY_LIMIT);
      // The browser of the RcRef, to not invalidate a newer one when an older browser's page fails late
      const current = yield* Ref.make<PlaywrightBrowser | undefined>(undefined);

      const launchOnce = metrics.increment("browserLaunches").pipe(
        Effect.zipRight(
          Effect.tryPromise({
            try: () => launch({ headless: true, ...LAUNCH_OPTIONS }),
            catch: (cause) => new BrowserLaunchError({ cause }),
          }),
        ),
      );
      const launchBrowser = launchOnce.pipe(
        Effect.catchIf(isMissingBrowserExecutable, () =>
          Effect.logInfo("Playwright Chromium is missing, installing...").pipe(
            Effect.zipRight(install),
            Effect.zipRight(launchOnce),
          ),
        ),
      );

      // Lazy: nothing is launched until the first page. A failed launch is not kept, the next page tries again.
      const sharedBrowser = yield* RcRef.make({
        acquire: Effect.acquireRelease(
          launchBrowser.pipe(Effect.tap((browser) => Ref.set(current, browser))),
          (browser) =>
            Ref.update(current, (latest) => (latest === browser ? undefined : latest)).pipe(
              Effect.zipRight(closeQuietly(browser)),
            ),
        ),
        idleTimeToLive: Duration.infinity,
      });

      const attempt = <A, E, R>(
        options: { readonly userAgent?: string; readonly timeout: number },
        use: (page: Page) => Effect.Effect<A, E, R>,
      ): Effect.Effect<PageAttempt<A, E | PlaywrightError>, BrowserLaunchError, R> =>
        Effect.scoped(
          Effect.gen(function* () {
            const browser = yield* RcRef.get(sharedBrowser);
            const exit = yield* Effect.exit(
              Effect.scoped(openPage(browser, options).pipe(Effect.flatMap(use))),
            );
            if (Exit.isSuccess(exit) || browser.isConnected()) {
              return { exit, crash: undefined };
            }
            // The next page launches a new browser
            if ((yield* Ref.get(current)) === browser) {
              yield* RcRef.invalidate(sharedBrowser);
            }
            return { exit, crash: exit.cause };
          }),
        );

      return {
        withPage: (options, use) =>
          pageSlots.withPermits(1)(
            Effect.gen(function* () {
              const first = yield* attempt(options, use);
              if (first.crash === undefined) {
                return yield* first.exit;
              }
              yield* Effect.logWarning(
                `Browser disconnected (${getErrorMessage(Cause.squash(first.crash))}), relaunching and retrying once...`,
              );
              return yield* (yield* attempt(options, use)).exit;
            }),
          ),
      };
    }),
  );
}
