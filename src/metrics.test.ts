import { it } from "@effect/vitest";
import { Effect, Fiber, Layer, TestClock } from "effect";
import { describe, expect } from "vitest";
import { LogLayer } from "./logger";
import { formatRunMetrics, Metrics } from "./metrics";
import { makeTestConsole } from "./test/test_console";

/** Runs `use` with the metrics of a run and returns what the end of the run logged to stdout */
const logged = <A, E>(use: (metrics: Metrics["Type"]) => Effect.Effect<A, E>) => {
  const testConsole = makeTestConsole();
  return Effect.gen(function* () {
    yield* Effect.flatMap(Metrics, use).pipe(Effect.provide(Metrics.layer), Effect.exit);
    return testConsole.stdout;
  }).pipe(Effect.provide(LogLayer({ json: false })), Effect.withConsole(testConsole.console));
};

describe("Metrics", () => {
  it.effect("logs the counters and phases at the end of the run, in the order of the labels", () =>
    Effect.gen(function* () {
      const output = yield* logged((metrics) =>
        Effect.gen(function* () {
          yield* metrics.increment("httpRequests", 3);
          yield* metrics.increment("totalLinks");
          yield* metrics.increment("httpRequests");
          yield* metrics.timePhase("Slow phase", TestClock.adjust(1500));
          yield* metrics.timePhase("Quick phase", TestClock.adjust(20));
          yield* TestClock.adjust(500);
        }),
      );

      expect(output).toEqual([
        [
          "Run metrics:",
          "  Total links: 1",
          "  HTTP requests (incl. redirects and retries): 4",
          "  Phases:",
          "    Slow phase: 1.5s",
          "    Quick phase: 20ms",
          "  Total: 2.0s",
        ].join("\n"),
      ]);
    }),
  );

  it.effect("logs also when the run fails, and records the phase that failed", () =>
    Effect.gen(function* () {
      const output = yield* logged((metrics) =>
        metrics.timePhase(
          "Failing phase",
          TestClock.adjust(100).pipe(Effect.zipRight(Effect.fail("boom"))),
        ),
      );

      expect(output.join("\n")).toContain("Failing phase: 100ms");
    }),
  );

  it.effect("logs also when the run is interrupted", () =>
    Effect.gen(function* () {
      const testConsole = makeTestConsole();
      yield* Effect.gen(function* () {
        const fiber = yield* Effect.gen(function* () {
          const metrics = yield* Metrics;
          yield* metrics.increment("playwrightNavigations");
          return yield* Effect.never;
        }).pipe(Effect.provide(Metrics.layer), Effect.fork);
        yield* Effect.yieldNow();
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(LogLayer({ json: false })), Effect.withConsole(testConsole.console));

      expect(testConsole.stdout.join("\n")).toContain("Playwright navigations: 1");
    }),
  );

  it.effect("keeps separate totals per layer instance", () =>
    Effect.gen(function* () {
      const first = yield* Effect.flatMap(Metrics, (metrics) =>
        metrics.increment("totalLinks").pipe(Effect.zipRight(metrics.snapshot)),
      ).pipe(Effect.provide(Layer.fresh(Metrics.layer)));
      const second = yield* Effect.flatMap(Metrics, (metrics) => metrics.snapshot).pipe(
        Effect.provide(Layer.fresh(Metrics.layer)),
      );

      expect(first.counters).toEqual({ totalLinks: 1 });
      expect(second.counters).toEqual({});
    }),
  );
});

describe("formatRunMetrics()", () => {
  it("omits counters that were never incremented and the phases without any", () => {
    expect(formatRunMetrics({ counters: { browserLaunches: 1 }, phases: [], totalMs: 999 })).toBe(
      "Run metrics:\n  Browser launches: 1\n  Total: 999ms",
    );
  });
});
