import { Effect, Either } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostLimiter } from "./limiter";
import { incrementMetric, runCached, type RunServices, timePhase, withRun } from "./run";

afterEach(() => {
  vi.restoreAllMocks();
});

const runInRun = <A, E>(
  effect: Effect.Effect<A, E, RunServices>,
  config: Parameters<typeof withRun>[0] = {},
) => Effect.runPromise(effect.pipe(withRun(config)));

describe("withRun()", () => {
  it("logs metrics and phase timings at the end of the run", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runInRun(
      Effect.gen(function* () {
        yield* incrementMetric("totalLinks", 10);
        yield* incrementMetric("uniqueUrls", 4);
        yield* incrementMetric("playwrightNavigations");
        yield* timePhase("Check links", Effect.void);
      }),
    );

    const output = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
    expect(output).toContain("Run metrics:");
    expect(output).toContain("Total links: 10");
    expect(output).toContain("Unique URLs: 4");
    expect(output).toContain("Playwright navigations: 1");
    expect(output).toMatch(/Check links: \d+ms/);
    expect(output).toMatch(/Total: \d+/);
  });

  it("logs metrics and records the phase also when the run fails", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const failing = Effect.gen(function* () {
      yield* incrementMetric("totalLinks");
      yield* timePhase("Failing phase", Effect.fail("boom"));
    });

    await expect(runInRun(failing)).rejects.toThrow("boom");

    const output = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
    expect(output).toContain("Total links: 1");
    expect(output).toContain("Failing phase");
  });

  it("applies the run's config to the host limiter", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const limits = await runInRun(
      Effect.flatMap(HostLimiter, (limiter) => Effect.succeed(limiter.limitPerHost)),
      { hostConcurrency: 3 },
    );
    expect(limits).toBe(3);
    expect(await runInRun(Effect.map(HostLimiter, (limiter) => limiter.limitPerHost))).toBe(8);
  });

  it("every run has its own cache", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let calls = 0;
    const cached = runCached(
      "key",
      Effect.sync(() => ++calls),
    );
    expect(await runInRun(cached)).toBe(1);
    expect(await runInRun(cached)).toBe(2);
  });
});

describe("runCached()", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("concurrent callers share one execution, later callers get the cached value", async () => {
    let calls = 0;
    const slow = Effect.gen(function* () {
      calls++;
      yield* Effect.sleep(5);
      return "value";
    });
    const hits: string[] = [];
    const onHit = Effect.sync(() => hits.push("hit"));

    const results = await runInRun(
      Effect.gen(function* () {
        const concurrent = yield* Effect.all(
          Array.from({ length: 5 }, () => runCached("key", slow, { onHit })),
          { concurrency: "unbounded" },
        );
        return [...concurrent, yield* runCached("key", slow, { onHit })];
      }),
    );

    expect(results).toEqual(Array(6).fill("value"));
    expect(calls).toBe(1);
    expect(hits).toHaveLength(5);
  });

  it("does not cache failures by default, so the next call retries", async () => {
    let calls = 0;
    const flaky = Effect.suspend(() =>
      ++calls === 1 ? Effect.fail("first") : Effect.succeed("ok"),
    );

    const results = await runInRun(
      Effect.gen(function* () {
        const first = yield* Effect.either(runCached("key", flaky));
        return [first, yield* runCached("key", flaky)] as const;
      }),
    );

    expect(results).toEqual([Either.left("first"), "ok"]);
    expect(calls).toBe(2);
  });

  it("caches failures that `cacheError` accepts", async () => {
    let calls = 0;
    const notFound = Effect.suspend(() => Effect.fail(`missing ${++calls}`));
    const options = { cacheError: (error: string) => error.startsWith("missing") };

    const results = await runInRun(
      Effect.gen(function* () {
        const first = yield* Effect.either(runCached("key", notFound, options));
        const second = yield* Effect.either(runCached("key", notFound, options));
        return [first, second];
      }),
    );

    expect(results).toEqual([Either.left("missing 1"), Either.left("missing 1")]);
    expect(calls).toBe(1);
  });

  it("concurrent callers of a failing call all get the failure", async () => {
    const failing = Effect.zipRight(Effect.sleep(5), Effect.fail("nope"));

    const results = await runInRun(
      Effect.all(
        Array.from({ length: 3 }, () => Effect.either(runCached("key", failing))),
        { concurrency: "unbounded" },
      ),
    );

    expect(results).toEqual(Array(3).fill(Either.left("nope")));
  });
});
