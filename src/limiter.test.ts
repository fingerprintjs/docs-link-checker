import { Deferred, Effect, Fiber, Option } from "effect";
import { describe, expect, it } from "vitest";
import { HostLimiter, parseHostConcurrency, parseRetryAfter } from "./limiter";

/** Runs an Effect with a limiter of `limitPerHost` slots per host (real clock) */
const runLimited = <A, E>(limitPerHost: number, effect: Effect.Effect<A, E, HostLimiter>) =>
  Effect.runPromise(Effect.provide(effect, HostLimiter.layer(limitPerHost)));

describe("HostLimiter", () => {
  it("limits concurrency per host, hosts are independent", () =>
    runLimited(
      2,
      Effect.gen(function* () {
        const limiter = yield* HostLimiter;
        const perHost: Record<string, { active: number; max: number }> = {};
        let totalMax = 0;
        let totalActive = 0;

        const urls = Array.from(
          { length: 30 },
          (_, i) => `https://host-${i % 3}.example.com/page-${i}`,
        );
        yield* Effect.forEach(
          urls,
          (url) =>
            limiter.run(
              url,
              Effect.gen(function* () {
                const host = new URL(url).hostname;
                perHost[host] ??= { active: 0, max: 0 };
                perHost[host].active++;
                perHost[host].max = Math.max(perHost[host].max, perHost[host].active);
                totalActive++;
                totalMax = Math.max(totalMax, totalActive);
                yield* Effect.sleep(5);
                perHost[host].active--;
                totalActive--;
              }),
            ),
          { concurrency: "unbounded" },
        );

        expect(Object.values(perHost).map((host) => host.max)).toEqual([2, 2, 2]);
        // Different hosts run in parallel
        expect(totalMax).toBe(6);
      }),
    ));

  it("delays new requests to a paused host", () =>
    runLimited(
      5,
      Effect.gen(function* () {
        const limiter = yield* HostLimiter;
        yield* limiter.pause("https://paused.example.com/a", 50);
        const start = Date.now();
        yield* limiter.run("https://paused.example.com/b", Effect.void);
        expect(Date.now() - start).toBeGreaterThanOrEqual(45);

        // Other hosts are not affected
        const otherStart = Date.now();
        yield* limiter.run("https://other.example.com/", Effect.void);
        expect(Date.now() - otherStart).toBeLessThan(40);
      }),
    ));

  it("waitUntilResumed() waits for a pause without taking a slot", () =>
    runLimited(
      1,
      Effect.gen(function* () {
        const limiter = yield* HostLimiter;
        const release = yield* Deferred.make<void>();
        // The only slot stays busy, waitUntilResumed must not wait for it
        const busy = yield* Effect.fork(
          limiter.run("https://paused.example.com/", Deferred.await(release)),
        );
        // Let the busy request start before the pause
        yield* Effect.sleep(0);
        yield* limiter.pause("https://paused.example.com/a", 50);
        const start = Date.now();
        yield* limiter.waitUntilResumed("https://paused.example.com/b");
        expect(Date.now() - start).toBeGreaterThanOrEqual(45);

        const otherStart = Date.now();
        yield* limiter.waitUntilResumed("https://other.example.com/");
        yield* limiter.waitUntilResumed("not a url");
        expect(Date.now() - otherStart).toBeLessThan(40);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(busy);
      }),
    ));

  it("does not limit invalid URLs", () =>
    runLimited(
      1,
      Effect.gen(function* () {
        const limiter = yield* HostLimiter;
        expect(yield* limiter.run("not a url", Effect.succeed("ok"))).toBe("ok");
      }),
    ));

  it("frees the slot of an effect that is interrupted by a timeout", () =>
    runLimited(
      1,
      Effect.gen(function* () {
        const limiter = yield* HostLimiter;
        const url = "https://slow.example.com/";
        const timedOut = yield* limiter.run(url, Effect.never).pipe(Effect.timeoutOption(5));
        expect(Option.isNone(timedOut)).toBe(true);
        // Would wait forever if the cancelled work still held the only slot
        expect(yield* limiter.run(url, Effect.succeed("next"))).toBe("next");
      }),
    ));
});

describe("parseRetryAfter()", () => {
  it("parses seconds and HTTP dates", () => {
    expect(parseRetryAfter("30")).toBe(30000);
    const now = Date.parse("2025-01-01T00:00:00Z");
    expect(parseRetryAfter("Wed, 01 Jan 2025 00:00:10 GMT", now)).toBe(10000);
    expect(parseRetryAfter("Tue, 31 Dec 2024 00:00:00 GMT", now)).toBe(0);
  });

  it("returns undefined for missing or invalid values", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });
});

describe("parseHostConcurrency()", () => {
  it("defaults to 8 and can be configured", () => {
    expect(parseHostConcurrency(undefined)).toBe(8);
    expect(parseHostConcurrency("")).toBe(8);
    expect(parseHostConcurrency("3")).toBe(3);
  });

  it.each(["0", "-1", "1.5", "abc"])("rejects %s", (value) => {
    expect(() => parseHostConcurrency(value)).toThrow("LINK_CHECK_HOST_CONCURRENCY");
  });
});
