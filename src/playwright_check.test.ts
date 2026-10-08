/**
 * Offline tests for `checkUrlsOnPageWithPlaywright` over a fake Chromium. The fake browser evaluates selectors with
 * cheerio, so browser specific behavior (selector syntax, hash navigation) is only covered by the integration tests.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Clock, Effect, Fiber, Layer, Logger, LogLevel, Option, TestClock } from "effect";
import { describe, expect } from "vitest";
import { Browser } from "./browser";
import { DEFAULT_HOST_CONCURRENCY } from "./config";
import { BrowserLaunchError } from "./errors";
import { HostLimiter } from "./limiter";
import { Metrics } from "./metrics";
import {
  checkUrlsOnPageWithPlaywright,
  HASH_FALLBACK_WAIT_TIMEOUT,
  HASH_WAIT_TIMEOUT,
  PAGE_OPERATION_TIMEOUT,
} from "./playwright_check";
import { runWithClock, settle } from "./test/clock";
import { fakeChromium, makeFakeChromiumState } from "./test/fake_chromium";

const hashesHtml = readFileSync(join(import.meta.dirname, "__fixtures__", "hashes.html"), "utf8");

const silent = Logger.minimumLogLevel(LogLevel.None);

/** Real `Browser`, `HostLimiter` and `Metrics` over a fake Chromium */
const setup = () => {
  const state = makeFakeChromiumState();
  const layer = Layer.mergeAll(Browser.layer, HostLimiter.layer(DEFAULT_HOST_CONCURRENCY)).pipe(
    Layer.provideMerge(Layer.mergeAll(fakeChromium(state), Metrics.layer)),
    Layer.provideMerge(silent),
  );
  return {
    state,
    provide: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(layer)),
  };
};

const checkOne = (url: string) =>
  checkUrlsOnPageWithPlaywright([url]).pipe(Effect.map((results) => results.get(url)));

/**
 * Runs `effect` on the test clock until it is done. A missing anchor takes its whole wait, like in a real browser.
 * Returns the result and how long it took (simulated time, exact: all waits are multiples of the clock step).
 */
const timed = <A, E, R>(state: { waitForTakesTimeout: boolean }, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    state.waitForTakesTimeout = true;
    const start = yield* Clock.currentTimeMillis;
    return yield* runWithClock(
      effect.pipe(
        Effect.flatMap((value) =>
          Effect.map(Clock.currentTimeMillis, (end) => ({ result: value, took: end - start })),
        ),
      ),
      "10 minutes",
    );
  });

describe("checkUrlsOnPageWithPlaywright() hash check", () => {
  // Special characters are covered by hash.test.ts, this only checks the wiring
  it.effect("finds a hash with special characters", () => {
    const { state, provide } = setup();
    state.html = hashesHtml;
    return provide(
      Effect.gen(function* () {
        expect(yield* checkOne("https://example.com/docs#caf%C3%A9")).toEqual({
          ok: true,
          status: 200,
        });
      }),
    );
  });

  it.effect("reports missing hashes as 'hash not found'", () => {
    const { state, provide } = setup();
    state.html = hashesHtml;
    return provide(
      Effect.gen(function* () {
        expect(yield* checkOne("https://example.com/docs#it's-%22missing%22")).toEqual({
          ok: false,
          status: 200,
          error: "hash not found",
        });
      }),
    );
  });

  it.effect("accepts a link without hash", () => {
    const { state, provide } = setup();
    return provide(
      Effect.gen(function* () {
        expect(yield* checkOne("https://example.com/docs")).toEqual({ ok: true, status: 200 });
        expect(state.visited).toEqual(["https://example.com/docs"]);
      }),
    );
  });

  it.effect("accepts Google Help accordion fragments without waiting for an element", () => {
    const { provide } = setup();
    return provide(
      Effect.gen(function* () {
        expect(
          yield* checkOne("https://support.google.com/answer/10787469#zippy=%2Cdata-sharing"),
        ).toEqual({ ok: true, status: 200, note: "Google Help accordion state" });
      }),
    );
  });

  it.effect("reports a 404 page as a broken link", () => {
    const { state, provide } = setup();
    state.status = 404;
    return provide(
      Effect.gen(function* () {
        expect(yield* checkOne("https://example.com/missing#a")).toEqual({
          ok: false,
          error: "broken link",
          status: 404,
        });
      }),
    );
  });

  it.effect("waits longer for an anchor rendered late (same navigation)", () => {
    const { state, provide } = setup();
    const url = "https://docs.example.com/reference/get-event#response-ip-info-v6-address";
    // Added by a timer 4s after the navigation, on an already loaded and quiet page (e.g. Mintlify expands nested
    // response fields on hash navigation)
    state.lateHtmlByUrl = {
      [url]: { html: '<div id="response-ip-info-v6-address"></div>', afterMs: 4000 },
    };
    return provide(
      Effect.gen(function* () {
        const { result, took } = yield* timed(state, checkOne(url));

        expect(result).toEqual({ ok: true, status: 200 });
        expect(state.visited).toEqual([url]);
        // Found as soon as it appears, the rest of the budget is not waited
        expect(took).toBe(4000);
        expect((yield* (yield* Metrics).snapshot).counters["playwrightLongHashWaits"]).toBe(1);
      }),
    );
  });

  it.effect("waits for a missing anchor until the 15s budget is used up", () => {
    const { state, provide } = setup();
    return provide(
      Effect.gen(function* () {
        const { result, took } = yield* timed(state, checkOne("https://example.com/docs#never"));

        expect(result).toEqual({ ok: false, status: 200, error: "hash not found" });
        expect(state.visited).toEqual(["https://example.com/docs#never"]);
        expect(took).toBe(HASH_FALLBACK_WAIT_TIMEOUT);
      }),
    );
  });

  it.effect("reports an anchor rendered after the budget as missing", () => {
    const { state, provide } = setup();
    const url = "https://example.com/docs#too-late";
    state.lateHtmlByUrl = { [url]: { html: '<div id="too-late"></div>', afterMs: 16_000 } };
    return provide(
      Effect.gen(function* () {
        const { result, took } = yield* timed(state, checkOne(url));

        expect(result).toEqual({ ok: false, status: 200, error: "hash not found" });
        expect(took).toBe(HASH_FALLBACK_WAIT_TIMEOUT);
      }),
    );
  });

  it.effect.each([401, 403])("reports a %s page with its body", (status) => {
    const { state, provide } = setup();
    state.status = status;
    return provide(
      Effect.gen(function* () {
        const result = yield* checkOne("https://example.com/docs#a");

        expect(result).toMatchObject({ ok: false, status, error: "could not check" });
        expect(!result?.ok && result?.errorDetail).toContain("Forbidden page");
      }),
    );
  });

  it.effect("does not wait forever for the body of a forbidden page", () => {
    const { state, provide } = setup();
    state.status = 403;
    state.responseBodyHangs = true;
    return provide(
      Effect.gen(function* () {
        const { result, took } = yield* timed(state, checkOne("https://example.com/docs#a"));

        expect(result).toMatchObject({ ok: false, status: 403, error: "could not check" });
        expect(took).toBe(PAGE_OPERATION_TIMEOUT);
      }),
    );
  });

  describe("GitHub code line links", () => {
    const file = "https://github.com/owner/repo/blob/main/a.js";
    const codeView =
      '<div data-line-number="1"></div><div data-line-number="2"></div><div data-line-number="3"></div>';

    it.effect.each(["#L2", "#L1-L3"])("finds line %s in the code view", (hash) => {
      const { state, provide } = setup();
      state.html = codeView;
      return provide(
        Effect.gen(function* () {
          expect(yield* checkOne(`${file}${hash}`)).toEqual({ ok: true, status: 200 });
        }),
      );
    });

    it.effect.each(["#L99", "#L99-L120"])(
      "reports line %s beyond the end of the file without the long wait",
      (hash) => {
        const { state, provide } = setup();
        state.html = codeView;
        return provide(
          Effect.gen(function* () {
            const { result, took } = yield* timed(state, checkOne(`${file}${hash}`));

            expect(result).toEqual({ ok: false, status: 200, error: "hash not found" });
            // The code view is there, so only the line itself is waited for briefly
            expect(took).toBe(HASH_WAIT_TIMEOUT);
          }),
        );
      },
    );

    it.effect("reports a line as not found when the code view never renders", () => {
      const { state, provide } = setup();
      state.html = "<div>This file is too big to show</div>";
      return provide(
        Effect.gen(function* () {
          const { result, took } = yield* timed(state, checkOne(`${file}#L2`));

          expect(result).toEqual({ ok: false, status: 200, error: "hash not found" });
          expect(took).toBe(HASH_FALLBACK_WAIT_TIMEOUT);
        }),
      );
    });

    it.effect("checks the lines of one file with one navigation", () => {
      const { state, provide } = setup();
      state.html =
        '<html><body><div data-line-number="5"></div><div data-line-number="6"></div></body></html>';
      const urls = ["#L5", "#L6", "#L5-L6", "#L99"].map((hash) => `${file}${hash}`);
      return provide(
        Effect.gen(function* () {
          const { result } = yield* timed(state, checkUrlsOnPageWithPlaywright(urls));

          expect(state.visited).toEqual([`${file}#L5`]);
          expect(urls.filter((url) => result.get(url)?.ok)).toEqual(urls.slice(0, 3));
          expect(result.get(`${file}#L99`)).toMatchObject({ error: "hash not found" });
        }),
      );
    });
  });
});

describe("checkUrlsOnPageWithPlaywright() hashes of one page", () => {
  const page = "https://docs.example.com/app";

  /** Checks the hashes of `page` with the test clock */
  const checkHashes = (state: { waitForTakesTimeout: boolean }, hashes: string[]) =>
    timed(state, checkUrlsOnPageWithPlaywright(hashes.map((hash) => `${page}${hash}`))).pipe(
      Effect.map(({ result, took }) => ({
        byHash: new Map([...result].map(([url, checked]) => [url.slice(page.length), checked])),
        took,
      })),
    );

  it.effect("returns no results for no URLs, without a browser", () => {
    const { state, provide } = setup();
    return provide(
      Effect.gen(function* () {
        expect((yield* checkUrlsOnPageWithPlaywright([])).size).toBe(0);
        expect(state.launches).toBe(0);
      }),
    );
  });

  it.effect("navigates once and checks each hash in the same DOM", () => {
    const { state, provide } = setup();
    state.html = '<html><body><h2 id="one">One</h2><a name="two"></a></body></html>';
    return provide(
      Effect.gen(function* () {
        const { byHash } = yield* checkHashes(state, ["#one", "#two", "#three"]);

        expect(state.visited).toEqual([`${page}#one`]);
        expect(byHash.get("#one")).toEqual({ ok: true, status: 200 });
        expect(byHash.get("#two")).toEqual({ ok: true, status: 200 });
        expect(byHash.get("#three")).toEqual({ ok: false, status: 200, error: "hash not found" });
      }),
    );
  });

  it.effect("finds late anchors of every hash with one navigation and one shared wait", () => {
    const { state, provide } = setup();
    // Both anchors are added by a timer 4s after the navigation (e.g. expanded nested fields)
    state.lateHtmlByUrl = {
      [`${page}#a`]: { html: '<div id="a"></div><div id="b"></div>', afterMs: 4000 },
    };
    return provide(
      Effect.gen(function* () {
        const { byHash, took } = yield* checkHashes(state, ["#a", "#b"]);

        expect(byHash.get("#a")).toEqual({ ok: true, status: 200 });
        expect(byHash.get("#b")).toEqual({ ok: true, status: 200 });
        expect(state.visited).toEqual([`${page}#a`]);
        expect(took).toBe(4000);
      }),
    );
  });

  it.effect(
    "finds a hash that is rendered only after the hash is set in the open page (SPA tabs)",
    () => {
      const { state, provide } = setup();
      state.htmlByUrl = {
        [`${page}#tab-a`]: '<div id="tab-a"></div>',
        [`${page}#tab-b`]: '<div id="tab-b"></div>',
      };
      return provide(
        Effect.gen(function* () {
          const { byHash } = yield* checkHashes(state, ["#tab-a", "#tab-b", "#missing"]);

          expect(byHash.get("#tab-a")).toEqual({ ok: true, status: 200 });
          expect(byHash.get("#tab-b")).toEqual({ ok: true, status: 200 });
          expect(byHash.get("#missing")).toEqual({
            ok: false,
            status: 200,
            error: "hash not found",
          });
          // No navigation per hash
          expect(state.visited).toEqual([`${page}#tab-a`]);
          expect((yield* (yield* Metrics).snapshot).counters["playwrightHashFallbacks"]).toBe(2);
        }),
      );
    },
  );

  it.effect(
    "keeps 'hash not found' for a hash whose in-page retry fails, other results stay",
    () => {
      const { state, provide } = setup();
      state.evaluateFails = true;
      state.htmlByUrl = { [`${page}#a`]: '<div id="a"></div>' };
      return provide(
        Effect.gen(function* () {
          const { byHash } = yield* checkHashes(state, ["#a", "#missing"]);

          expect(byHash.get("#a")).toEqual({ ok: true, status: 200 });
          expect(byHash.get("#missing")).toEqual({
            ok: false,
            status: 200,
            error: "hash not found",
          });
        }),
      );
    },
  );

  it.effect("stops the in-page retries of a page that hangs, other results stay", () => {
    const { state, provide } = setup();
    state.evaluateHangs = true;
    state.htmlByUrl = { [`${page}#a`]: '<div id="a"></div>' };
    return provide(
      Effect.gen(function* () {
        const { byHash, took } = yield* checkHashes(state, ["#a", "#missing", "#missing2"]);

        expect(byHash.get("#a")).toEqual({ ok: true, status: 200 });
        expect(byHash.get("#missing")).toEqual({ ok: false, status: 200, error: "hash not found" });
        expect(byHash.get("#missing2")).toEqual({
          ok: false,
          status: 200,
          error: "hash not found",
        });
        // 15s shared wait, then one 3s timeout (the next hash is not tried)
        expect(took).toBe(HASH_FALLBACK_WAIT_TIMEOUT + HASH_WAIT_TIMEOUT);
      }),
    );
  });

  it.effect("spends the 15s budget once per page, not once per missing hash", () => {
    const { state, provide } = setup();
    return provide(
      Effect.gen(function* () {
        const { byHash, took } = yield* checkHashes(state, ["#a", "#b", "#c", "#d"]);

        for (const hash of ["#a", "#b", "#c", "#d"]) {
          expect(byHash.get(hash)).toEqual({ ok: false, status: 200, error: "hash not found" });
        }
        // 15s shared wait, then 3s for each of the 3 hashes set in the page
        expect(took).toBe(HASH_FALLBACK_WAIT_TIMEOUT + 3 * HASH_WAIT_TIMEOUT);
      }),
    );
  });
});

describe("checkUrlsOnPageWithPlaywright() browser problems", () => {
  it.effect("reports navigation errors as broken links, without relaunching", () => {
    const { state, provide } = setup();
    state.nextGotoFailure = "error";
    return provide(
      Effect.gen(function* () {
        const result = yield* checkOne("https://does-not-exist.example.com");

        expect(result).toMatchObject({ ok: false, error: "broken link" });
        expect(!result?.ok && result?.errorDetail).toContain("ERR_NAME_NOT_RESOLVED");
        expect(state.launches).toBe(1);
      }),
    );
  });

  it.effect("relaunches the browser when it crashes during navigation and checks again", () => {
    const { state, provide } = setup();
    state.nextGotoFailure = "crash";
    return provide(
      Effect.gen(function* () {
        expect(yield* checkOne("https://example.com/crash")).toEqual({ ok: true, status: 200 });
        expect(state.launches).toBe(2);
      }),
    );
  });

  it.effect("fails (not a broken link) when the browser cannot be launched", () => {
    const { state, provide } = setup();
    state.failLaunch = "other";
    return provide(
      Effect.gen(function* () {
        const error = yield* Effect.flip(checkOne("https://blocked.example.com/a"));

        expect(error).toBeInstanceOf(BrowserLaunchError);
        expect(error.message).toContain("Failed to launch");
      }),
    );
  });
});

describe("checkUrlsOnPageWithPlaywright() server errors (502, 503, 504)", () => {
  it.effect("retries the navigation after a 503 and checks the code line", () => {
    const { state, provide } = setup();
    state.statuses = [503];
    state.html = '<div data-line-number="167"></div>';
    const url = "https://github.com/owner/repo/blob/main/a.js#L167";
    return provide(
      Effect.gen(function* () {
        const { result, took } = yield* timed(state, checkOne(url));

        expect(result).toEqual({ ok: true, status: 200 });
        expect(state.visited).toEqual([url, url]);
        expect(took).toBe(2000);
        expect((yield* (yield* Metrics).snapshot).counters["serverErrorRetries"]).toBe(1);
      }),
    );
  });

  it.effect("respects Retry-After of a 503 navigation", () => {
    const { state, provide } = setup();
    state.statuses = [503];
    state.headers = { "retry-after": "8" };
    return provide(
      Effect.gen(function* () {
        const { result, took } = yield* timed(state, checkOne("https://busy.example.com/page"));

        expect(result).toEqual({ ok: true, status: 200 });
        expect(state.visited).toHaveLength(2);
        expect(took).toBe(8000);
      }),
    );
  });

  it.effect("gives up right away when Retry-After is longer than the maximum delay", () => {
    const { state, provide } = setup();
    state.status = 503;
    state.headers = { "retry-after": "120" };
    return provide(
      Effect.gen(function* () {
        const { result, took } = yield* timed(state, checkOne("https://busy.example.com/page"));

        expect(result).toMatchObject({ ok: false, error: "could not check", status: 503 });
        expect(state.visited).toHaveLength(1);
        expect(took).toBe(0);
      }),
    );
  });

  it.effect(
    "reports a 503 that persists after the retries as 'could not check', not broken",
    () => {
      const { state, provide } = setup();
      state.status = 503;
      const url = "https://busy.example.com/page";
      return provide(
        Effect.gen(function* () {
          const { result, took } = yield* timed(state, checkOne(url));

          expect(result).toMatchObject({ ok: false, error: "could not check", status: 503 });
          // 1 navigation and 2 retries, no more
          expect(state.visited).toEqual([url, url, url]);
          expect(took).toBe(2000 + 5000);
        }),
      );
    },
  );

  it.effect("waits for a host pause (e.g. set by a fetch server error) before navigating", () => {
    const { state, provide } = setup();
    return provide(
      Effect.gen(function* () {
        const { result, took } = yield* timed(
          state,
          Effect.gen(function* () {
            yield* (yield* HostLimiter).pause("https://busy.example.com/", 3000);
            return yield* checkOne("https://busy.example.com/page");
          }),
        );

        expect(result).toEqual({ ok: true, status: 200 });
        expect(took).toBe(3000);
      }),
    );
  });

  it.effect(
    "after a redirect to another host, a 503 pauses the final URL's host and the retry waits for it",
    () => {
      const { state, provide } = setup();
      const url = "https://short.example.com/x";
      const final = "https://busy.example.com/page";
      state.finalUrlByUrl = { [url]: final };
      state.statuses = [503];
      return provide(
        Effect.gen(function* () {
          const limiter = yield* HostLimiter;
          const checked = yield* Effect.fork(checkOne(url));
          yield* settle;

          // Only the final URL's host is paused, not the navigated URL's
          const navigatedWait = yield* Effect.fork(limiter.waitUntilResumed(url));
          const finalWait = yield* Effect.fork(limiter.waitUntilResumed(final));
          yield* settle;
          expect(Option.isSome(yield* Fiber.poll(navigatedWait))).toBe(true);
          expect(Option.isNone(yield* Fiber.poll(finalWait))).toBe(true);

          yield* TestClock.adjust(2000);
          yield* settle;
          yield* Fiber.join(finalWait);

          expect(yield* Fiber.join(checked)).toEqual({ ok: true, status: 200 });
          expect(state.visited).toEqual([url, url]);
        }),
      );
    },
  );
});
