import { it } from "@effect/vitest";
import { Effect, Fiber, Layer, Logger, LogLevel, Option, TestClock } from "effect";
import { describe, expect } from "vitest";
import { FetchError, TooManyRedirects } from "./errors";
import {
  classifyStatus,
  fetchLimited,
  getUserAgent,
  parseRetryAfter,
  planServerErrorRetry,
  USER_AGENT,
} from "./http";
import { HostLimiter } from "./limiter";
import { LogLayer } from "./logger";
import { Metrics } from "./metrics";
import { settle } from "./test/clock";
import { type FetchHandler, fakeFetch } from "./test/fake_fetch";
import { makeTestConsole } from "./test/test_console";

const text = (response: Response) => response.text();

const redirect = (location: string, status = 301) =>
  new Response("moved", { status, headers: { Location: location } });

const silent = Logger.minimumLogLevel(LogLevel.None);

/** Real `HostLimiter` and `Metrics` over a fake `fetch` */
const setup = (handler: FetchHandler, hostConcurrency = 2, { quiet = true } = {}) => {
  const fake = fakeFetch(handler);
  const layer = Layer.mergeAll(HostLimiter.layer(hostConcurrency), fake.layer).pipe(
    Layer.provideMerge(Metrics.layer),
    Layer.provideMerge(quiet ? silent : Layer.empty),
  );
  return {
    calls: fake.calls,
    paths: () => fake.calls.map(({ url }) => new URL(url).pathname),
    provide: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(layer)),
  };
};

/** Moves the test clock and lets the promise based fake `fetch` answer */
const advance = (ms: number) => TestClock.adjust(ms).pipe(Effect.zipRight(settle));

const isRunning = <A, E>(fiber: Fiber.RuntimeFiber<A, E>) =>
  Fiber.poll(fiber).pipe(Effect.map(Option.isNone));

describe("fetchLimited() 429 rate limits", () => {
  it.effect(
    "pauses the host before releasing the slot, so a queued request does not start during Retry-After",
    () => {
      let first = true;
      const { provide, paths } = setup((url) => {
        if (url.endsWith("/a") && first) {
          first = false;
          return new Response(null, { status: 429, headers: { "Retry-After": "1" } });
        }
        return new Response(url.slice(-1), { status: 200 });
      }, 1);
      return provide(
        Effect.gen(function* () {
          const fiber = yield* Effect.all(
            [
              fetchLimited("https://limited.example.com/a", {}, text),
              fetchLimited("https://limited.example.com/b", {}, text),
            ],
            { concurrency: "unbounded" },
          ).pipe(Effect.fork);
          yield* settle;
          yield* advance(999);
          expect(paths()).toEqual(["/a"]);
          yield* advance(1);

          const results = yield* Fiber.join(fiber);
          expect(results.map((result) => [result.status, result.data])).toEqual([
            [200, "a"],
            [200, "b"],
          ]);
          // The retry of /a takes the freed slot before the queued /b, which started only after the pause
          expect(paths()).toEqual(["/a", "/a", "/b"]);
        }),
      );
    },
  );

  it.effect("returns the last 429 after the retries", () => {
    const { provide, calls } = setup(
      () => new Response("slow down", { status: 429, headers: { "Retry-After": "0" } }),
    );
    return provide(
      Effect.gen(function* () {
        const result = yield* fetchLimited("https://limited.example.com/", {}, text);
        expect(result).toMatchObject({ status: 429, data: "slow down" });
        // The request, then 2 retries
        expect(calls).toHaveLength(3);
      }),
    );
  });

  it.effect("does not retry a 429 without a usable Retry-After", () => {
    const { provide, calls } = setup(() => new Response(null, { status: 429 }));
    return provide(
      Effect.gen(function* () {
        const result = yield* fetchLimited("https://limited.example.com/", {}, text);
        expect(result.status).toBe(429);
        expect(calls).toHaveLength(1);
      }),
    );
  });

  it.effect("does not wait for a Retry-After longer than the task timeout", () => {
    const { provide, calls } = setup(
      () => new Response(null, { status: 429, headers: { "Retry-After": "3600" } }),
    );
    return provide(
      Effect.gen(function* () {
        const result = yield* fetchLimited("https://limited.example.com/", {}, text);
        expect(result.status).toBe(429);
        expect(calls).toHaveLength(1);
      }),
    );
  });

  it.effect("logs the retry with the parsed delay", () => {
    let first = true;
    const { provide } = setup(
      () => {
        if (first) {
          first = false;
          return new Response(null, { status: 429, headers: { "Retry-After": "2" } });
        }
        return new Response("ok");
      },
      2,
      { quiet: false },
    );
    const testConsole = makeTestConsole();
    return provide(
      Effect.gen(function* () {
        const fiber = yield* fetchLimited("https://limited.example.com/x", {}, text).pipe(
          Effect.fork,
        );
        yield* settle;
        yield* advance(2000);
        yield* Fiber.join(fiber);
        expect(testConsole.stdout).toEqual([
          "Rate limited (https://limited.example.com/x), retrying after 2s (Retry-After: 2)...",
        ]);
        expect(testConsole.stderr).toEqual([]);
      }).pipe(Effect.provide(LogLayer({ json: false })), Effect.withConsole(testConsole.console)),
    );
  });
});

describe("fetchLimited() server errors (502, 503, 504)", () => {
  it.effect.each([502, 503, 504])(
    "retries a %s with a backoff of 2s, then 5s, then returns the success",
    (status) => {
      let failures = 2;
      const { provide, calls } = setup(() =>
        failures-- > 0 ? new Response("busy", { status }) : new Response("ok", { status: 200 }),
      );
      return provide(
        Effect.gen(function* () {
          const fiber = yield* fetchLimited("https://busy.example.com/", {}, text).pipe(
            Effect.fork,
          );
          yield* settle;
          yield* advance(1999);
          expect(calls).toHaveLength(1);
          yield* advance(1);
          expect(calls).toHaveLength(2);
          yield* advance(4999);
          expect(calls).toHaveLength(2);
          yield* advance(1);

          expect(yield* Fiber.join(fiber)).toMatchObject({ status: 200, data: "ok" });
          expect(calls).toHaveLength(3);
          const metrics = yield* (yield* Metrics).snapshot;
          expect(metrics.counters).toMatchObject({ serverErrorRetries: 2, httpRequests: 3 });
        }),
      );
    },
  );

  it.effect("returns the last 503 after the retries, cancelling every unread body", () => {
    let cancelled = 0;
    const { provide, calls } = setup(
      () =>
        new Response(
          new ReadableStream({
            cancel: () => {
              cancelled++;
            },
          }),
          { status: 503 },
        ),
    );
    return provide(
      Effect.gen(function* () {
        const fiber = yield* fetchLimited("https://busy.example.com/", {}, () =>
          Promise.resolve("not read"),
        ).pipe(Effect.fork);
        yield* settle;
        yield* advance(7000);

        expect((yield* Fiber.join(fiber)).status).toBe(503);
        // The request, then 2 retries
        expect(calls).toHaveLength(3);
        expect(cancelled).toBe(3);
      }),
    );
  });

  it.effect(
    "respects a Retry-After longer than the backoff and pauses the host for queued requests",
    () => {
      let first = true;
      const { provide, paths } = setup((url) => {
        if (url.endsWith("/a") && first) {
          first = false;
          return new Response(null, { status: 503, headers: { "Retry-After": "8" } });
        }
        return new Response("ok", { status: 200 });
      }, 1);
      return provide(
        Effect.gen(function* () {
          const fiber = yield* Effect.all(
            [
              fetchLimited("https://busy.example.com/a", {}, text),
              fetchLimited("https://busy.example.com/b", {}, text),
            ],
            { concurrency: "unbounded" },
          ).pipe(Effect.fork);
          yield* settle;
          yield* advance(7999);
          expect(paths()).toEqual(["/a"]);
          yield* advance(1);

          expect((yield* Fiber.join(fiber)).map((result) => result.status)).toEqual([200, 200]);
          expect(paths()).toEqual(["/a", "/a", "/b"]);
        }),
      );
    },
  );

  it.effect("does not retry when Retry-After is longer than the maximum delay", () => {
    const { provide, calls } = setup(
      () => new Response(null, { status: 503, headers: { "Retry-After": "3600" } }),
    );
    return provide(
      Effect.gen(function* () {
        // No clock movement: it would hang if the request waited
        expect((yield* fetchLimited("https://busy.example.com/", {}, text)).status).toBe(503);
        expect(calls).toHaveLength(1);
      }),
    );
  });

  it.effect("does not retry other 5xx statuses", () => {
    const { provide, calls } = setup(() => new Response(null, { status: 500 }));
    return provide(
      Effect.gen(function* () {
        yield* fetchLimited("https://busy.example.com/500", {}, text);
        expect(calls).toHaveLength(1);
      }),
    );
  });
});

describe("planServerErrorRetry()", () => {
  const plan = (retries: number, retryAfter: string | null) =>
    planServerErrorRetry({
      url: "https://busy.example.com/",
      status: 503,
      retries,
      retryAfter,
    }).pipe(Effect.provide(Metrics.layer), Effect.provide(silent));

  it.effect("backs off 2s, then 5s, and gives up after 2 retries", () =>
    Effect.gen(function* () {
      expect(yield* plan(0, null)).toEqual(Option.some(2000));
      expect(yield* plan(1, null)).toEqual(Option.some(5000));
      expect(yield* plan(2, null)).toEqual(Option.none());
    }),
  );

  it.effect(
    "allows a Retry-After of up to 10s, ignores an invalid one, gives up on a longer one",
    () =>
      Effect.gen(function* () {
        expect(yield* plan(1, "10")).toEqual(Option.some(10_000));
        expect(yield* plan(0, "invalid")).toEqual(Option.some(2000));
        expect(yield* plan(0, "11")).toEqual(Option.none());
      }),
  );
});

describe("fetchLimited() redirects", () => {
  it.effect("follows redirects manually and returns the final status, URL and body", () => {
    const { provide, calls } = setup((url) => {
      if (url === "https://old.example.com/page") {
        return redirect("https://new.example.com/start", 301);
      }
      if (url === "https://new.example.com/start") {
        return redirect("/final?x=1", 307);
      }
      return new Response("final", { status: 200 });
    });
    return provide(
      Effect.gen(function* () {
        const result = yield* fetchLimited(
          "https://old.example.com/page",
          { method: "HEAD" },
          text,
        );

        expect(result).toMatchObject({
          status: 200,
          url: "https://new.example.com/final?x=1",
          data: "final",
        });
        // HEAD stays HEAD on 301 and 307, a relative Location is resolved against the current URL
        expect(calls.map(({ url, init }) => [url, init.method, init.redirect])).toEqual([
          ["https://old.example.com/page", "HEAD", "manual"],
          ["https://new.example.com/start", "HEAD", "manual"],
          ["https://new.example.com/final?x=1", "HEAD", "manual"],
        ]);
      }),
    );
  });

  it.live("respects the per-host limit of the redirect destination", () => {
    let active = 0;
    let maxActive = 0;
    const { provide } = setup(async (url) => {
      if (!url.startsWith("https://destination.example.com/")) {
        // Every source host redirects to the same destination host
        return redirect(`https://destination.example.com/${new URL(url).hostname}`);
      }
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return new Response("ok", { status: 200 });
    });
    return provide(
      Effect.gen(function* () {
        const results = yield* Effect.forEach(
          Array.from({ length: 12 }, (_, i) => `https://source-${i}.example.com/`),
          (url) => fetchLimited(url, {}, text),
          { concurrency: "unbounded" },
        );

        expect(results.every((result) => result.status === 200)).toBe(true);
        expect(maxActive).toBe(2);
      }),
    );
  });

  it.effect("gives up after 10 redirects", () => {
    const { provide, calls } = setup((url) => redirect(`${url}x`, 302));
    return provide(
      Effect.gen(function* () {
        const error = yield* fetchLimited("https://loop.example.com/", {}, text).pipe(Effect.flip);

        expect(error).toBeInstanceOf(TooManyRedirects);
        expect(error.message).toBe(
          "Too many redirects (more than 10) for https://loop.example.com/",
        );
        expect(calls).toHaveLength(11);
      }),
    );
  });

  it.effect(
    "follows an empty Location (resolves to the current URL), so a self-redirect loop fails",
    () => {
      const { provide, calls } = setup(() => redirect("", 302));
      return provide(
        Effect.gen(function* () {
          const error = yield* fetchLimited("https://self.example.com/", {}, text).pipe(
            Effect.flip,
          );
          expect(error).toBeInstanceOf(TooManyRedirects);
          expect(calls).toHaveLength(11);
        }),
      );
    },
  );

  it.effect("returns a 3xx without Location as the final response", () => {
    const { provide } = setup(() => new Response(null, { status: 301 }));
    return provide(
      Effect.gen(function* () {
        expect((yield* fetchLimited("https://example.com/", {}, text)).status).toBe(301);
      }),
    );
  });
});

describe("fetchLimited() unread response bodies", () => {
  /** A body that records if it was cancelled, and whether the request still held its host slot then */
  const trackedResponse = (limiter: HostLimiter["Type"], url: string, headers?: HeadersInit) => {
    const tracking = { cancelled: false, slotHeldOnCancel: false };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("chunk"));
      },
      async cancel() {
        tracking.cancelled = true;
        // A request queued now starts only if the slot is already released
        let probeStarted = false;
        void Effect.runPromise(
          limiter.withSlot(
            url,
            Effect.sync(() => {
              probeStarted = true;
            }),
          ),
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
        tracking.slotHeldOnCancel = !probeStarted;
      },
    });
    return { response: new Response(body, { status: headers ? 302 : 200, headers }), tracking };
  };

  it.live("cancels a body the reader did not consume before releasing the slot", () => {
    const url = "https://example.com/big-file";
    let tracked: ReturnType<typeof trackedResponse> | undefined;
    const { provide } = setup(() => tracked?.response ?? new Response(), 1);
    return provide(
      Effect.gen(function* () {
        tracked = trackedResponse(yield* HostLimiter, url);
        yield* fetchLimited(url, {}, () => Promise.resolve("not read"));
        expect(tracked.tracking).toEqual({ cancelled: true, slotHeldOnCancel: true });
      }),
    );
  });

  it.live("cancels the body of a redirect response while holding the slot of its host", () => {
    let tracked: ReturnType<typeof trackedResponse> | undefined;
    const { provide } = setup(
      (url) =>
        url === "https://a.example.com/"
          ? (tracked?.response ?? new Response())
          : new Response("ok", { status: 200 }),
      1,
    );
    return provide(
      Effect.gen(function* () {
        tracked = trackedResponse(yield* HostLimiter, "https://a.example.com/", {
          Location: "https://b.example.com/",
        });
        const result = yield* fetchLimited("https://a.example.com/", {}, text);

        expect(result).toMatchObject({ status: 200, url: "https://b.example.com/" });
        expect(tracked.tracking).toEqual({ cancelled: true, slotHeldOnCancel: true });
      }),
    );
  });
});

describe("fetchLimited() failures", () => {
  it.effect("fails with a FetchError that keeps the cause, shown like the original error", () => {
    const { provide } = setup(() => {
      throw new TypeError("fetch failed");
    });
    return provide(
      Effect.gen(function* () {
        const error = yield* fetchLimited("https://down.example.com/", {}, text).pipe(Effect.flip);

        expect(error).toBeInstanceOf(FetchError);
        expect(error.message).toBe("fetch failed");
        expect(String(error)).toBe("TypeError: fetch failed");
        expect(error).toMatchObject({ _tag: "FetchError", url: "https://down.example.com/" });
      }),
    );
  });

  it.effect("fails with a FetchError when the body cannot be read", () => {
    const { provide } = setup(() => new Response("ok"));
    return provide(
      Effect.gen(function* () {
        const error = yield* fetchLimited("https://example.com/", {}, () =>
          Promise.reject(new Error("body broke")),
        ).pipe(Effect.flip);
        expect(error.message).toBe("body broke");
      }),
    );
  });

  it.effect(
    "times out a request that never answers (20s by default), like AbortSignal.timeout",
    () => {
      const { provide } = setup(() => new Promise<Response>(() => {}));
      return provide(
        Effect.gen(function* () {
          const fiber = yield* fetchLimited("https://hang.example.com/", {}, text).pipe(
            Effect.flip,
            Effect.fork,
          );
          yield* settle;
          yield* advance(19_999);
          expect(yield* isRunning(fiber)).toBe(true);
          yield* advance(1);

          const error = yield* Fiber.join(fiber);
          expect(error).toBeInstanceOf(FetchError);
          expect(error.message).toBe("The operation was aborted due to timeout");
          expect(String(error)).toBe("TimeoutError: The operation was aborted due to timeout");
        }),
      );
    },
  );

  it.effect("times out per request, also when the body never ends, and releases the slot", () => {
    const { provide } = setup(
      (url) =>
        url.endsWith("/stuck")
          ? new Response(new ReadableStream({ start: () => {} }), { status: 200 })
          : new Response("ok"),
      1,
    );
    return provide(
      Effect.gen(function* () {
        const stuck = yield* fetchLimited(
          "https://slow.example.com/stuck",
          { timeoutMs: 1000 },
          text,
        ).pipe(Effect.flip, Effect.fork);
        const next = yield* fetchLimited("https://slow.example.com/next", {}, text).pipe(
          Effect.fork,
        );
        yield* settle;
        yield* advance(1000);

        expect((yield* Fiber.join(stuck)).message).toBe("The operation was aborted due to timeout");
        expect((yield* Fiber.join(next)).data).toBe("ok");
      }),
    );
  });

  it.effect("aborts the request when interrupted", () => {
    const { provide, calls } = setup(() => new Promise<Response>(() => {}));
    return provide(
      Effect.gen(function* () {
        const fiber = yield* fetchLimited("https://hang.example.com/", {}, text).pipe(Effect.fork);
        yield* settle;
        expect(calls[0]?.init.signal?.aborted).toBe(false);
        yield* Fiber.interrupt(fiber);
        expect(calls[0]?.init.signal?.aborted).toBe(true);
      }),
    );
  });
});

describe("fetchLimited() request options", () => {
  it.effect("sends the method and headers, counts every request", () => {
    const { provide, calls } = setup(() => new Response("ok"));
    return provide(
      Effect.gen(function* () {
        yield* fetchLimited(
          "https://example.com/",
          { method: "HEAD", headers: { "User-Agent": "test" } },
          text,
        );
        expect(calls[0]?.init).toMatchObject({ method: "HEAD", headers: { "User-Agent": "test" } });
        expect((yield* (yield* Metrics).snapshot).counters).toEqual({ httpRequests: 1 });
      }),
    );
  });
});

describe("parseRetryAfter()", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");

  it("parses seconds", () => {
    expect(parseRetryAfter("5", now)).toBe(5000);
    expect(parseRetryAfter(" 0 ", now)).toBe(0);
  });

  it("parses an HTTP date relative to now, a past date is 0", () => {
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfter("Wed, 31 Dec 2025 23:00:00 GMT", now)).toBe(0);
  });

  it("returns undefined for a missing or invalid value", () => {
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter("", now)).toBeUndefined();
    expect(parseRetryAfter("soon", now)).toBeUndefined();
  });
});

describe("classifyStatus()", () => {
  it("separates success, forbidden, transient server errors and the rest", () => {
    expect([200, 301, 308].map(classifyStatus)).toEqual(["okay", "okay", "okay"]);
    expect([401, 403].map(classifyStatus)).toEqual(["forbidden", "forbidden"]);
    expect([502, 503, 504].map(classifyStatus)).toEqual([
      "server-error",
      "server-error",
      "server-error",
    ]);
    expect([204, 404, 429, 500].map(classifyStatus)).toEqual(["other", "other", "other", "other"]);
  });
});

describe("getUserAgent()", () => {
  it("is the desktop Chrome user agent, except for android.com", () => {
    expect(getUserAgent("https://example.com/")).toBe(USER_AGENT);
    expect(getUserAgent("https://developer.android.com/guide")).toBeUndefined();
  });
});
