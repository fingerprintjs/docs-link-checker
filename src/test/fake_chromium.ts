/**
 * Fake `Chromium` for tests: no browser is started. Pages "render" HTML from the state, selectors are evaluated
 * with cheerio, so browser specific behavior (selector syntax, real hash navigation) is only covered by the
 * integration tests. Waits use the Effect clock, so `TestClock` controls them.
 */
// oxlint-disable typescript/require-await -- Playwright methods return promises, the fake mostly answers at once
import * as cheerio from "cheerio";
import { Clock, Effect, Layer, Runtime } from "effect";
import type { Browser as PlaywrightBrowser } from "playwright";
import { Chromium } from "../browser";
import { BrowserLaunchError } from "../errors";

/** Mutable on purpose: a test sets what the next browser calls do and reads what happened */
export type FakeChromiumState = {
  // What happened
  launches: number;
  closes: number;
  openPages: number;
  maxOpenPages: number;
  /** URLs Playwright navigated to */
  visited: string[];
  /** Route handler of the latest context, as registered by `withPage` */
  routeHandler: ((route: unknown) => Promise<void>) | undefined;

  /** Runs of the Chromium installer (it is never really run) */
  installs: number;
  /** The installer fails */
  failInstall: boolean;
  /** Called by the installer, e.g. to make the next launch work */
  onInstall: () => void;

  // Browser failures
  /** `launch` fails: "missing" = executable not installed, "other" = any other reason */
  failLaunch: false | "missing" | "other";
  /** The next `newContext` fails as if the browser crashed */
  crashNextContext: boolean;
  /** The next navigation fails: "crash" closes the browser, "error" is a navigation error (e.g. DNS) */
  nextGotoFailure: "crash" | "error" | undefined;
  /** Setting the hash throws (e.g. the page navigated away) */
  evaluateFails: boolean;
  /** Setting the hash never returns (the page main thread is hung) */
  evaluateHangs: boolean;
  /** The navigation response body never ends (Playwright has no timeout for it) */
  responseBodyHangs: boolean;

  // What the pages look like
  /** Delay of every navigation */
  gotoDelayMs: number;
  /** HTML the fake browser "renders" */
  html: string;
  /** HTML per navigated URL (hash included), falls back to `html` */
  htmlByUrl: Record<string, string>;
  /**
   * HTML per navigated URL that is rendered `afterMs` after the navigation (anchors rendered late, e.g. by a
   * timer on an already loaded and quiet page). Before that `html` applies.
   */
  lateHtmlByUrl: Record<string, { html: string; afterMs: number }>;
  /** A missing selector takes its whole timeout, like in a real browser (instead of failing right away) */
  waitForTakesTimeout: boolean;
  status: number;
  /** Statuses of the next navigations (one per `goto`), then `status` */
  statuses: number[];
  /** Headers of the navigation response (lowercase names, like Playwright) */
  headers: Record<string, string>;
  /** Final URL of a navigation (after redirects) per navigated URL, falls back to the navigated URL */
  finalUrlByUrl: Record<string, string>;
};

export const makeFakeChromiumState = (): FakeChromiumState => ({
  launches: 0,
  closes: 0,
  installs: 0,
  failInstall: false,
  onInstall: () => {},
  openPages: 0,
  maxOpenPages: 0,
  visited: [],
  routeHandler: undefined,
  failLaunch: false,
  crashNextContext: false,
  nextGotoFailure: undefined,
  evaluateFails: false,
  evaluateHangs: false,
  responseBodyHangs: false,
  gotoDelayMs: 0,
  html: "<html><body></body></html>",
  htmlByUrl: {},
  lateHtmlByUrl: {},
  waitForTakesTimeout: false,
  status: 200,
  statuses: [],
  headers: {},
  finalUrlByUrl: {},
});

/** Runs `location.hash = value` code of `evaluate` against a fake `location` */
const evaluateWithLocation = (
  fn: (hash: string) => void,
  hash: string,
  setHash: (value: string) => void,
) => {
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: {
      set hash(value: string) {
        setHash(value);
      },
    },
  });
  try {
    fn(hash);
  } finally {
    Reflect.deleteProperty(globalThis, "location");
  }
};

/** Fake of Playwright's `chromium`, behavior and records are in `state` */
export const fakeChromium = (state: FakeChromiumState): Layer.Layer<Chromium> =>
  Layer.effect(
    Chromium,
    Effect.map(Effect.runtime(), (runtime) => {
      // The clock of the test (`TestClock`), not the real one
      const run = Runtime.runPromise(runtime);
      const sleep = (ms: number) => run(Effect.sleep(ms));
      const now = () => run(Clock.currentTimeMillis);

      return {
        install: Effect.suspend(() => {
          state.installs++;
          state.onInstall();
          return state.failInstall
            ? Effect.fail(new BrowserLaunchError({ cause: new Error("playwright install failed") }))
            : Effect.void;
        }),
        launch: async () => {
          state.launches++;
          if (state.failLaunch === "missing") {
            throw new Error("browserType.launch: Executable doesn't exist");
          }
          if (state.failLaunch === "other") {
            throw new Error("browserType.launch: Failed to launch: Target closed");
          }
          let connected = true;
          const browser = {
            isConnected: () => connected,
            close: async () => {
              state.closes++;
              connected = false;
            },
            newContext: async () => {
              if (state.crashNextContext) {
                state.crashNextContext = false;
                connected = false;
                throw new Error("Target page, context or browser has been closed");
              }
              return {
                route: async (_pattern: string, handler: (route: unknown) => Promise<void>) => {
                  state.routeHandler = handler;
                },
                close: async () => {
                  state.openPages--;
                },
                newPage: async () => {
                  state.openPages++;
                  state.maxOpenPages = Math.max(state.maxOpenPages, state.openPages);
                  let closed = false;
                  let currentUrl = "";
                  let navigatedAt = 0;
                  return {
                    isClosed: () => closed,
                    setDefaultTimeout: () => {},
                    setDefaultNavigationTimeout: () => {},
                    goto: async (url: string) => {
                      const failure = state.nextGotoFailure;
                      state.nextGotoFailure = undefined;
                      if (failure === "crash") {
                        connected = false;
                        closed = true;
                        throw new Error("page.goto: Target crashed");
                      }
                      if (failure === "error") {
                        throw new Error("page.goto: net::ERR_NAME_NOT_RESOLVED");
                      }
                      currentUrl = url;
                      state.visited.push(url);
                      if (state.gotoDelayMs > 0) {
                        await sleep(state.gotoDelayMs);
                      }
                      navigatedAt = await now();
                      const status = state.statuses.shift() ?? state.status;
                      return {
                        status: () => status,
                        statusText: () => "",
                        url: () => state.finalUrlByUrl[url] ?? url,
                        headers: () => state.headers,
                        text: () =>
                          state.responseBodyHangs
                            ? new Promise<string>(() => {})
                            : Promise.resolve("Forbidden page"),
                      };
                    },
                    // Only used to set the hash of the page
                    evaluate: async (fn: (hash: string) => void, hash: string) => {
                      if (state.evaluateFails) {
                        throw new Error("Execution context was destroyed");
                      }
                      if (state.evaluateHangs) {
                        return new Promise<void>(() => {});
                      }
                      evaluateWithLocation(fn, hash, (value) => {
                        currentUrl = currentUrl.replace(/#.*/, "") + value;
                      });
                      return undefined;
                    },
                    locator: (selector: string) => ({
                      first: () => ({
                        waitFor: async (options?: { timeout?: number }) => {
                          const matches = (html: string) => cheerio.load(html)(selector).length > 0;
                          // Throws for invalid selectors, like Playwright would
                          if (matches(state.htmlByUrl[currentUrl] ?? state.html)) {
                            return;
                          }
                          const late = state.lateHtmlByUrl[currentUrl];
                          const lateIn = late
                            ? navigatedAt + late.afterMs - (await now())
                            : Number.NaN;
                          if (late && matches(late.html) && lateIn <= (options?.timeout ?? 0)) {
                            await sleep(Math.max(0, lateIn));
                            return;
                          }
                          if (state.waitForTakesTimeout) {
                            await sleep(options?.timeout ?? 0);
                          }
                          const error = new Error("Timeout");
                          error.name = "TimeoutError";
                          throw error;
                        },
                      }),
                    }),
                  };
                },
              };
            },
          };
          // Only the methods used by `Browser` exist
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- partial fake of a Playwright browser
          return browser as unknown as PlaywrightBrowser;
        },
      };
    }),
  );
