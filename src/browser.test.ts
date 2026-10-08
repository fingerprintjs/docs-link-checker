/**
 * Offline tests for the shared browser (`browser.ts`) over a fake Chromium.
 */
import { it } from "@effect/vitest";
import { Effect, Exit, Layer, Logger, LogLevel } from "effect";
import type { Page } from "playwright";
import { describe, expect } from "vitest";
import { Browser, PLAYWRIGHT_CONCURRENCY_LIMIT, tryPlaywright } from "./browser";
import { BrowserLaunchError, PlaywrightError } from "./errors";
import { Metrics } from "./metrics";
import { runWithClock } from "./test/clock";
import { fakeChromium, makeFakeChromiumState } from "./test/fake_chromium";

const silent = Logger.minimumLogLevel(LogLevel.None);

/** Real `Browser` and `Metrics` over a fake Chromium. `provide` builds them for one effect and closes them after it. */
const setup = () => {
  const state = makeFakeChromiumState();
  const layer = Browser.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(fakeChromium(state), Metrics.layer)),
    Layer.provideMerge(silent),
  );
  return {
    state,
    layer,
    provide: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(layer)),
  };
};

const options = { timeout: 1000 };

/** A page use that navigates to `url` */
const visit = (url: string) => (page: Page) => tryPlaywright(() => page.goto(url));

const withPage = <A, E, R>(use: (page: Page) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(Browser, (browser) => browser.withPage(options, use));

describe("shared browser", () => {
  it.effect("launches one browser for many pages and closes it with the layer", () => {
    const { state, provide } = setup();
    return provide(
      Effect.forEach(
        Array.from({ length: 20 }, (_, i) => `https://example.com/${i}`),
        (url) => withPage(visit(url)),
        { concurrency: "unbounded" },
      ),
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(state.visited).toHaveLength(20);
          expect(state.launches).toBe(1);
          expect(state.closes).toBe(1);
          expect(state.openPages).toBe(0);
        }),
      ),
    );
  });

  it.effect("does not launch a browser when no page is needed", () => {
    const { state, provide } = setup();
    return provide(Effect.void).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(state.launches).toBe(0);
          expect(state.closes).toBe(0);
        }),
      ),
    );
  });

  it.effect("limits open pages and counts the launch", () => {
    const { state, provide } = setup();
    state.gotoDelayMs = 20;
    return provide(
      Effect.gen(function* () {
        yield* runWithClock(
          Effect.forEach(
            Array.from({ length: 12 }, (_, i) => `https://example.com/${i}`),
            (url) => withPage(visit(url)),
            { concurrency: "unbounded" },
          ),
          1000,
        );
        expect(state.maxOpenPages).toBe(PLAYWRIGHT_CONCURRENCY_LIMIT);
        expect((yield* (yield* Metrics).snapshot).counters["browserLaunches"]).toBe(1);
      }),
    );
  });

  it.effect("relaunches a crashed browser once and retries the page", () => {
    const { state, provide } = setup();
    return provide(
      Effect.gen(function* () {
        yield* withPage(() => Effect.void);
        state.crashNextContext = true;

        yield* withPage(visit("https://example.com/after-crash"));

        expect(state.launches).toBe(2);
        expect(state.visited).toEqual(["https://example.com/after-crash"]);
      }),
    );
  });

  it.effect("relaunches the browser when it crashes during navigation and retries the page", () => {
    const { state, provide } = setup();
    return provide(
      Effect.gen(function* () {
        yield* withPage(() => Effect.void);
        state.nextGotoFailure = "crash";

        yield* withPage(visit("https://example.com/crash"));

        expect(state.launches).toBe(2);
      }),
    );
  });

  it.effect("relaunches only once, then the error surfaces", () => {
    const { state, provide } = setup();
    return provide(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          withPage((page) => {
            state.nextGotoFailure = "crash";
            return tryPlaywright(() => page.goto("https://example.com/crash"));
          }),
        );

        expect(exit).toEqual(Exit.fail(expect.any(PlaywrightError)));
        expect(state.launches).toBe(2);
      }),
    );
  });

  it.effect("does not retry errors that are not crashes, and closes the page", () => {
    const { state, provide } = setup();
    return provide(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(withPage(() => Effect.fail("boom")));

        expect(exit).toEqual(Exit.fail("boom"));
        expect(state.launches).toBe(1);
        expect(state.openPages).toBe(0);
      }),
    );
  });

  it.effect("fails with the launch error when the browser cannot be launched", () => {
    const { state, provide } = setup();
    state.failLaunch = "other";
    return provide(
      Effect.gen(function* () {
        const error = yield* Effect.flip(withPage(() => Effect.void));

        expect(error).toBeInstanceOf(BrowserLaunchError);
        expect(error.message).toContain("Failed to launch");
        expect(state.installs).toBe(0);
      }),
    );
  });

  it.effect("tries to launch again after a failed launch", () => {
    const { state, provide } = setup();
    state.failLaunch = "other";
    return provide(
      Effect.gen(function* () {
        yield* Effect.flip(withPage(() => Effect.void));
        state.failLaunch = false;

        yield* withPage(visit("https://example.com/a"));

        expect(state.launches).toBe(2);
        expect(state.visited).toEqual(["https://example.com/a"]);
      }),
    );
  });

  it.effect(
    "installs Chromium when the browser executable is missing and retries the launch",
    () => {
      const { state, provide } = setup();
      state.failLaunch = "missing";
      state.onInstall = () => {
        state.failLaunch = false;
      };
      return provide(
        Effect.gen(function* () {
          yield* withPage(visit("https://example.com/after-install"));

          expect(state.installs).toBe(1);
          expect(state.launches).toBe(2);
          expect(state.visited).toEqual(["https://example.com/after-install"]);
          expect((yield* (yield* Metrics).snapshot).counters["browserLaunches"]).toBe(2);
        }),
      );
    },
  );

  it.effect("fails with the install error when installing a missing Chromium fails", () => {
    const { state, provide } = setup();
    state.failLaunch = "missing";
    state.failInstall = true;
    return provide(
      Effect.gen(function* () {
        const error = yield* Effect.flip(withPage(() => Effect.void));

        expect(error).toBeInstanceOf(BrowserLaunchError);
        expect(error.message).toBe("playwright install failed");
        expect(state.installs).toBe(1);
        expect(state.launches).toBe(1);
      }),
    );
  });
});

describe("browser belongs to its layer", () => {
  it.effect("closes the browser when its own layer closes, independently of other layers", () => {
    const { state, layer } = setup();
    return Effect.scoped(
      Effect.gen(function* () {
        const second = yield* Layer.build(layer);
        yield* Effect.provide(withPage(visit("https://example.com/second")), second);

        yield* Effect.scoped(
          Effect.gen(function* () {
            const first = yield* Layer.build(layer);
            yield* Effect.provide(withPage(visit("https://example.com/first")), first);
          }),
        );

        // The first layer closed its own browser, the second one is still open
        expect(state.launches).toBe(2);
        expect(state.closes).toBe(1);
        yield* Effect.provide(withPage(visit("https://example.com/second-again")), second);
        expect(state.launches).toBe(2);
      }),
    ).pipe(Effect.tap(() => Effect.sync(() => expect(state.closes).toBe(2))));
  });

  it.effect("closes the browser when the work of the layer fails", () => {
    const { state, provide } = setup();
    return provide(
      Effect.gen(function* () {
        yield* withPage(visit("https://example.com/a"));
        return yield* Effect.fail("run failed");
      }),
    ).pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error).toBe("run failed");
          expect(state.closes).toBe(1);
        }),
      ),
    );
  });
});

describe("request blocking", () => {
  type FakeRequest = {
    resourceType: string;
    url: string;
    // Top-level navigation (the link being checked) or an iframe navigation
    navigation?: "main" | "iframe";
  };

  // Runs requests through the route handler `withPage` registered, returns the URLs that were aborted
  const run = (
    state: ReturnType<typeof makeFakeChromiumState>,
    requests: FakeRequest[],
    failResponse = false,
  ) =>
    withPage(() =>
      Effect.promise(async () => {
        const aborted: string[] = [];
        for (const { resourceType, url, navigation } of requests) {
          await state.routeHandler?.({
            request: () => ({
              resourceType: () => resourceType,
              url: () => url,
              isNavigationRequest: () => navigation !== undefined,
              frame: () => ({ parentFrame: () => (navigation === "iframe" ? {} : null) }),
            }),
            abort: async () => {
              aborted.push(url);
              if (failResponse) throw new Error("Target closed");
            },
            continue: async () => {
              if (failResponse) throw new Error("Target closed");
            },
          });
        }
        return aborted;
      }),
    );

  const main = (url: string): FakeRequest => ({
    resourceType: "document",
    url,
    navigation: "main",
  });
  const sub = (resourceType: string, url: string): FakeRequest => ({ resourceType, url });

  it.effect("blocks images, media and fonts, keeps scripts, styles and data requests", () => {
    const { state, provide } = setup();
    const heavy = ["image", "media", "font"].map((type) =>
      sub(type, `https://example.com/${type}`),
    );
    const light = ["script", "stylesheet", "xhr", "fetch"].map((type) =>
      sub(type, `https://example.com/${type}`),
    );
    return provide(
      Effect.gen(function* () {
        const aborted = yield* run(state, [main("https://example.com/"), ...heavy, ...light]);

        expect(aborted).toEqual(heavy.map((request) => request.url));
      }),
    );
  });

  it.effect("blocks analytics hosts and their subdomains, not look-alike hosts", () => {
    const { state, provide } = setup();
    const blocked = [
      "https://www.googletagmanager.com/gtm.js",
      "https://stats.g.doubleclick.net/r/collect",
      "https://api.segment.io/v1/t",
      "https://script.hotjar.com/modules.js",
    ];
    const allowed = [
      "https://notgoogletagmanager.com/x.js",
      "https://example.com/googletagmanager.com.js",
    ];
    return provide(
      Effect.gen(function* () {
        const aborted = yield* run(state, [
          main("https://example.com/"),
          ...[...blocked, ...allowed].map((url) => sub("script", url)),
        ]);

        expect(aborted).toEqual(blocked);
      }),
    );
  });

  it.effect("never blocks the checked link itself by type, but blocks analytics iframes", () => {
    const { state, provide } = setup();
    const iframe = "https://www.googletagmanager.com/ns.html";
    return provide(
      Effect.gen(function* () {
        const aborted = yield* run(state, [
          { resourceType: "image", url: "https://example.com/logo.png", navigation: "main" },
          { resourceType: "document", url: iframe, navigation: "iframe" },
        ]);

        expect(aborted).toEqual([iframe]);
      }),
    );
  });

  it.effect("does not block a vendor's own hosts when the checked page is hosted by it", () => {
    const { state, provide } = setup();
    return provide(
      Effect.gen(function* () {
        const aborted = yield* run(state, [
          main("https://segment.com/docs/"),
          sub("script", "https://cdn.segment.com/app.js"),
          sub("script", "https://www.googletagmanager.com/gtm.js"),
          sub("image", "https://segment.com/logo.png"),
        ]);

        expect(aborted).toEqual([
          "https://www.googletagmanager.com/gtm.js",
          "https://segment.com/logo.png",
        ]);
      }),
    );
  });

  it.effect("tracks the checked page per page and follows redirects of the main navigation", () => {
    const { state, provide } = setup();
    const script = sub("script", "https://cdn.segment.com/analytics.js");
    return provide(
      Effect.gen(function* () {
        // A previous segment.com page does not leak into the next page
        yield* run(state, [main("https://segment.com/")]);
        expect(yield* run(state, [main("https://example.com/"), script])).toEqual([script.url]);

        // A redirect to the vendor makes it the checked page
        expect(
          yield* run(state, [
            main("https://example.com/"),
            main("https://segment.com/docs"),
            script,
          ]),
        ).toEqual([]);
      }),
    );
  });

  it.effect("does not throw on invalid request URLs", () => {
    const { state, provide } = setup();
    return provide(
      Effect.gen(function* () {
        expect(yield* run(state, [sub("script", "not a url")])).toEqual([]);
      }),
    );
  });

  it.effect("ignores errors when the page is already closed", () => {
    const { state, provide } = setup();
    const requests = [
      sub("font", "https://example.com/a.woff2"),
      sub("script", "https://example.com/a.js"),
    ];
    return provide(
      Effect.gen(function* () {
        expect(yield* run(state, requests, true)).toEqual(["https://example.com/a.woff2"]);
      }),
    );
  });
});
