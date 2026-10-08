import { readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Logger, LogLevel } from "effect";
import { describe, expect } from "vitest";
import { checkLinkWithFetch, makePageCache } from "./fetch_check";
import { Metrics } from "./metrics";
import { runWithClock } from "./test/clock";
import { type FetchHandler, fakeFetch } from "./test/fake_fetch";
import { testRunLayer } from "./test/layers";

const hashesHtml = readFileSync(join(import.meta.dirname, "__fixtures__", "hashes.html"), "utf8");

/** Real `HostLimiter` and `Metrics` over a fake `fetch` */
const setup = (handler: FetchHandler) => {
  const fake = fakeFetch(handler);
  return {
    calls: fake.calls,
    provide: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provide(testRunLayer({ fetch: fake.layer })),
        Effect.provide(Logger.minimumLogLevel(LogLevel.None)),
      ),
  };
};

describe("checkLinkWithFetch()", () => {
  it.effect("reports a request that never answers as broken link after the timeout", () => {
    const { provide } = setup(() => new Promise<Response>(() => {}));
    return provide(
      Effect.gen(function* () {
        const result = yield* runWithClock(
          checkLinkWithFetch("https://example.com/slow"),
          "20 seconds",
        );
        expect(result).toEqual({
          ok: false,
          error: "broken link",
          errorDetail: "TimeoutError: The operation was aborted due to timeout",
        });
      }),
    );
  });

  it.effect("reports a network error as broken link without a status", () => {
    const { provide } = setup(() => {
      throw new TypeError("fetch failed");
    });
    return provide(
      Effect.gen(function* () {
        expect(yield* checkLinkWithFetch("https://example.com/down")).toEqual({
          ok: false,
          error: "broken link",
          errorDetail: "TypeError: fetch failed",
        });
      }),
    );
  });

  it.effect("reports a failed request, also for a link without a hash", () => {
    const { provide } = setup(() => new Response("Not found", { status: 404 }));
    return provide(
      Effect.gen(function* () {
        const result = yield* checkLinkWithFetch("https://example.com/missing");
        expect(result).toMatchObject({ ok: false, error: "broken link", status: 404 });
      }),
    );
  });

  it.effect("accepts a page that answers HEAD with 404 and GET with 200", () => {
    // support.google.com and chatgpt.com
    const { provide } = setup((_url, init) =>
      init.method === "HEAD" ? new Response(null, { status: 404 }) : new Response("ok"),
    );
    return provide(
      Effect.gen(function* () {
        expect(yield* checkLinkWithFetch("https://support.example.com/answer/1")).toEqual({
          ok: true,
          status: 200,
        });
      }),
    );
  });

  it.effect("sends the user agent, except to sites that block it", () => {
    const { provide, calls } = setup(() => new Response("ok"));
    return provide(
      Effect.gen(function* () {
        yield* checkLinkWithFetch("https://example.com/");
        yield* checkLinkWithFetch("https://developer.android.com/");
        expect(new Headers(calls[0]?.init.headers).get("User-Agent")).toContain("Chrome");
        expect(new Headers(calls[1]?.init.headers).get("User-Agent")).toBeNull();
      }),
    );
  });

  it.effect(
    "reports a 429 with Retry-After that persists after the retries as unexpected error",
    () => {
      const { provide } = setup(
        () => new Response(null, { status: 429, headers: { "Retry-After": "0" } }),
      );
      return provide(
        Effect.gen(function* () {
          expect(yield* checkLinkWithFetch("https://always-limited.example.com/")).toMatchObject({
            ok: false,
            error: "unexpected error",
            status: 429,
          });
        }),
      );
    },
  );

  it.effect("accepts Google Help accordion fragments without an element id", () => {
    const { provide } = setup(() => new Response("<html><body></body></html>", { status: 200 }));
    return provide(
      Effect.gen(function* () {
        const result = yield* checkLinkWithFetch(
          "https://support.google.com/answer/10787469#zippy=%2Cdata-sharing",
        );
        expect(result).toEqual({ ok: true, status: 200, note: "Google Help accordion state" });
      }),
    );
  });

  // Special characters are covered by hash.test.ts, these only check the wiring
  for (const hash of ["#version-1.2.3", "#caf%C3%A9"]) {
    it.effect(`finds hash ${hash} in server-rendered HTML`, () => {
      const { provide } = setup(() => new Response(hashesHtml, { status: 200 }));
      return provide(
        Effect.gen(function* () {
          const result = yield* checkLinkWithFetch(`https://example.com/docs${hash}`);
          expect(result).toEqual({ ok: true, status: 200 });
        }),
      );
    });
  }

  it.effect("reports missing hashes as 'hash not found' (not 'broken link')", () => {
    const { provide } = setup(() => new Response(hashesHtml, { status: 200 }));
    return provide(
      Effect.gen(function* () {
        const result = yield* checkLinkWithFetch("https://example.com/docs#version-9.9.9");
        expect(result).toEqual({ ok: false, status: 200, error: "hash not found" });
      }),
    );
  });
});

describe("checkLinkWithFetch() server errors (502, 503, 504)", () => {
  it.effect(
    "reports a 503 that persists after the retries as 'could not check', not broken",
    () => {
      const { provide, calls } = setup(() => new Response("busy", { status: 503 }));
      return provide(
        Effect.gen(function* () {
          const result = yield* runWithClock(
            checkLinkWithFetch("https://busy.example.com/page"),
            "10 seconds",
          );
          expect(result).toMatchObject({ ok: false, error: "could not check", status: 503 });
          expect(!result.ok && result.errorDetail).toContain("Server error 503");
          // The request, then 2 retries
          expect(calls).toHaveLength(3);
        }),
      );
    },
  );

  it.effect("checks the hash of a page that answers 503 first", () => {
    let failures = 2;
    const { provide } = setup(() =>
      failures-- > 0
        ? new Response("busy", { status: 503 })
        : new Response('<h2 id="x">X</h2>', { status: 200 }),
    );
    return provide(
      Effect.gen(function* () {
        const result = yield* runWithClock(
          checkLinkWithFetch("https://busy.example.com/page#x"),
          "10 seconds",
        );
        expect(result).toEqual({ ok: true, status: 200 });
      }),
    );
  });
});

describe("makePageCache()", () => {
  it.effect(
    "fetches a page once for all its hashes and checks every hash against the same HTML",
    () => {
      const { provide, calls } = setup(() => new Response(hashesHtml, { status: 200 }));
      const page = "https://example.com/docs";
      return provide(
        Effect.gen(function* () {
          const cache = yield* makePageCache(new Set([page]));
          const hashes = ["#version-1.2.3", "#legacy-anchor", "#caf%C3%A9", "#does-not-exist", ""];

          const results = yield* Effect.forEach(
            hashes,
            (hash) => checkLinkWithFetch(`${page}${hash}`, cache),
            { concurrency: "unbounded" },
          );

          // One GET for the page, also used by the link without a hash
          expect(calls).toHaveLength(1);
          expect(calls[0]?.init.method).toBe("GET");
          expect(results).toEqual([
            { ok: true, status: 200 },
            { ok: true, status: 200 },
            { ok: true, status: 200 },
            { ok: false, status: 200, error: "hash not found" },
            { ok: true, status: 200 },
          ]);
          const metrics = yield* Metrics;
          expect((yield* metrics.snapshot).counters).toMatchObject({ uniquePagesFetched: 1 });
        }),
      );
    },
  );

  it.effect("reports a broken page for every hash pointing to it (one request)", () => {
    const { provide, calls } = setup(() => new Response("Not found", { status: 404 }));
    return provide(
      Effect.gen(function* () {
        const cache = yield* makePageCache(new Set(["https://example.com/gone"]));

        const results = yield* Effect.forEach(["#a", "#b", "#c"], (hash) =>
          checkLinkWithFetch(`https://example.com/gone${hash}`, cache),
        );

        expect(calls).toHaveLength(1);
        expect(results).toEqual(
          Array.from({ length: 3 }, () =>
            expect.objectContaining({ ok: false, error: "broken link", status: 404 }),
          ),
        );
      }),
    );
  });
});
