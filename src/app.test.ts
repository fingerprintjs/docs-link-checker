import { it } from "@effect/vitest";
import { Effect, Exit, Logger, LogLevel } from "effect";
import { describe, expect } from "vitest";
import { liveRunLayer } from "./app";
import { Fetch } from "./http";
import { HostLimiter } from "./limiter";
import { checkLinks } from "./link";
import { Metrics } from "./metrics";

describe("liveRunLayer()", () => {
  it.effect(
    "builds without launching a browser or touching the network, each run has its own metrics",
    () =>
      Effect.gen(function* () {
        const run = Effect.gen(function* () {
          yield* Fetch;
          yield* HostLimiter;
          const metrics = yield* Metrics;
          yield* metrics.increment("totalLinks");
          return (yield* metrics.snapshot).counters;
        }).pipe(Effect.provide(liveRunLayer({ hostConcurrency: 2 })));

        expect(yield* run).toEqual({ totalLinks: 1 });
        expect(yield* run).toEqual({ totalLinks: 1 });
      }).pipe(Effect.provide(Logger.minimumLogLevel(LogLevel.None))),
  );

  it.effect("provides every service checkLinks needs", () =>
    // Stub of `checkLinks` dies: reaching it proves that the layer satisfies its requirements
    checkLinks({ links: [] }).pipe(
      Effect.provide(liveRunLayer({ hostConcurrency: 2 })),
      Effect.exit,
      Effect.map((exit) => expect(Exit.isFailure(exit)).toBe(true)),
      Effect.provide(Logger.minimumLogLevel(LogLevel.None)),
    ),
  );
});
