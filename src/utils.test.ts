import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Logger, LogLevel, Ref, TestClock } from "effect";
import { describe, expect } from "vitest";
import { LogLayer } from "./logger";
import { makeTestConsole } from "./test/test_console";
import { compareStrings, processAll, sampleItems } from "./utils";

/** Runs `effect` with the logs of the effect captured */
const withLogs = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  const testConsole = makeTestConsole();
  const run = effect.pipe(
    Effect.provide(LogLayer({ json: false })),
    Effect.withConsole(testConsole.console),
  );
  return { run, ...testConsole };
};

const silent = Logger.minimumLogLevel(LogLevel.None);

describe("processAll()", () => {
  it.effect(
    "returns results and errors in item order, a failing or dying item does not stop the others",
    () =>
      Effect.gen(function* () {
        const { results, errors } = yield* processAll({
          items: [1, 2, 3, 4, 5],
          process: (item) => {
            if (item === 2) {
              return Effect.fail("failed");
            }
            if (item === 4) {
              return Effect.die(new Error("defect"));
            }
            return Effect.succeed(item * 10);
          },
        });

        expect(results).toEqual([10, 30, 50]);
        expect(errors).toHaveLength(2);
        expect(errors[0]).toEqual({ item: 2, error: "failed" });
        expect(errors[1]?.item).toBe(4);
        expect(errors[1]?.error).toMatchObject({ message: "defect" });
      }).pipe(Effect.provide(silent)),
  );

  it.effect("runs at most `concurrency` items at once", () =>
    Effect.gen(function* () {
      const active = yield* Ref.make(0);
      const max = yield* Ref.make(0);
      const fiber = yield* processAll({
        items: Array.from({ length: 20 }, (_, i) => i),
        concurrency: 3,
        process: () =>
          Ref.updateAndGet(active, (n) => n + 1).pipe(
            Effect.flatMap((n) => Ref.update(max, (m) => Math.max(m, n))),
            Effect.zipRight(Effect.sleep(10)),
            Effect.zipRight(Ref.update(active, (n) => n - 1)),
          ),
      }).pipe(Effect.fork);
      yield* TestClock.adjust(1000);
      yield* Fiber.join(fiber);

      expect(yield* Ref.get(max)).toBe(3);
    }).pipe(Effect.provide(silent)),
  );

  it.effect("logs progress every 30s while running, stops when done, then the time taken", () => {
    const logs = withLogs(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const fiber = yield* processAll({
          items: [1, 2],
          process: (item) => (item === 2 ? Deferred.await(gate) : Effect.void),
        }).pipe(Effect.fork);
        yield* TestClock.adjust(29_999);
        expect(logs.stdout).toEqual([]);
        yield* TestClock.adjust(1);
        expect(logs.stdout).toEqual(["Progress: 1/2"]);
        yield* TestClock.adjust(30_000);
        expect(logs.stdout).toEqual(["Progress: 1/2", "Progress: 1/2"]);

        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(fiber);
        yield* TestClock.adjust(120_000);
        expect(logs.stdout).toEqual(["Progress: 1/2", "Progress: 1/2", "Time taken: 60000ms"]);
      }),
    );
    return logs.run;
  });

  it.effect("logs the time taken also when interrupted", () => {
    const logs = withLogs(
      Effect.gen(function* () {
        const fiber = yield* processAll({ items: [1], process: () => Effect.never }).pipe(
          Effect.fork,
        );
        yield* TestClock.adjust(5000);
        yield* Fiber.interrupt(fiber);
        expect(logs.stdout).toEqual(["Time taken: 5000ms"]);
      }),
    );
    return logs.run;
  });

  it.effect("logs the failed item and the error message (not [object Object]) to stderr", () => {
    const logs = withLogs(
      Effect.gen(function* () {
        yield* processAll({
          items: [
            { href: "https://example.com/ok", page: "https://example.com" },
            { href: "https://example.com/fails", page: "https://example.com/source" },
          ],
          process: (item) =>
            item.href.endsWith("fails")
              ? Effect.fail(new Error("Something exploded"))
              : Effect.succeed(item),
        });
        expect(logs.stderr).toEqual([
          "Errors processing items: 1\n  - https://example.com/fails (on https://example.com/source): Something exploded",
        ]);
      }),
    );
    return logs.run;
  });

  for (const { item, expected } of [
    { item: { full_name: "org/repo", name: "repo" }, expected: "org/repo" },
    {
      item: { sourcePath: "https://github.com/org/repo/blob/main/README.md" },
      expected: "https://github.com/org/repo/blob/main/README.md",
    },
    { item: "plain", expected: "plain" },
  ]) {
    it.effect(`names the failed item ${expected}`, () => {
      const logs = withLogs(
        Effect.gen(function* () {
          yield* processAll({ items: [item], process: () => Effect.fail("Something exploded") });
          expect(logs.stderr.join("\n")).toContain(`  - ${expected}: Something exploded`);
        }),
      );
      return logs.run;
    });
  }
});

describe("sampleItems()", () => {
  const items = Array.from(
    { length: 100 },
    (_, i) => `https://example.com/page-${String(i).padStart(3, "0")}`,
  );
  const shuffled = items.toReversed();
  const sample = (list: string[], rate: number) =>
    sampleItems({ items: list, key: (x) => x, rate }).pipe(Effect.provide(silent));

  it.effect("returns all items with rate 1", () =>
    Effect.gen(function* () {
      expect(yield* sample(shuffled, 1)).toEqual(shuffled);
    }),
  );

  it.effect("returns every Nth item of the sorted list", () =>
    Effect.gen(function* () {
      const picked = yield* sample(shuffled, 0.1);
      expect(picked).toHaveLength(10);
      expect(picked).toEqual(items.filter((_, i) => i % 10 === 0));
    }),
  );

  it.effect("is deterministic regardless of the input order", () =>
    Effect.gen(function* () {
      const a = yield* sample(items, 0.3);
      const b = yield* sample(shuffled, 0.3);
      expect(a).toEqual(b);
      expect(a).toHaveLength(30);
    }),
  );

  it.effect("returns at least one item", () =>
    Effect.gen(function* () {
      expect(yield* sample(items, 0)).toHaveLength(1);
      expect(yield* sample(["only"], 0.01)).toEqual(["only"]);
      expect(yield* sample([], 0.5)).toEqual([]);
    }),
  );

  it.effect("logs the sample size with the label, only when sampling", () => {
    const logs = withLogs(
      Effect.gen(function* () {
        yield* sampleItems({ items, key: (x) => x, rate: 0.1, label: "README files" });
        yield* sampleItems({ items, key: (x) => x, rate: 1 });
        expect(logs.stdout).toEqual(["Sampling 10 of 100 README files (sample rate 0.1)."]);
      }),
    );
    return logs.run;
  });
});

describe("compareStrings()", () => {
  it("orders by code unit, not by locale", () => {
    expect(["b", "B", "a", "ä"].toSorted(compareStrings)).toEqual(["B", "a", "b", "ä"]);
    expect(compareStrings("a", "a")).toBe(0);
  });
});
