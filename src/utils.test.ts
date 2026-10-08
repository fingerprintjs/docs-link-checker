import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { getSampleRate, parallelProcess, processInParallel, sampleItems } from "./utils";

let logSpy: MockInstance<typeof console.log>;
let errorSpy: MockInstance<typeof console.error>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("parallelProcess() progress", () => {
  it("logs progress while running and stops when done", async () => {
    vi.useFakeTimers();
    let resolve = () => {};
    const slow = new Promise<void>((done) => {
      resolve = done;
    });

    const run = parallelProcess({
      items: [1, 2],
      processFn: async (item) => (item === 2 ? slow : undefined),
    });
    await vi.advanceTimersByTimeAsync(30000);
    expect(logSpy).toHaveBeenCalledWith("Progress: 1/2");

    resolve();
    await run;
    logSpy.mockClear();
    await vi.advanceTimersByTimeAsync(60000);
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe("parallelProcess() error logging", () => {
  it("logs the failed item and the error message (not [object Object])", async () => {
    const items = [
      { href: "https://example.com/ok", page: "https://example.com", text: "ok" },
      { href: "https://example.com/fails", page: "https://example.com/source", text: "fails" },
    ];

    const { errors } = await parallelProcess({
      items,
      processFn: async (item) => {
        if (item.href.endsWith("fails")) {
          throw new Error("Something exploded");
        }
        return item;
      },
    });

    expect(errors).toHaveLength(1);
    const output = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain(
      "https://example.com/fails (on https://example.com/source): Something exploded",
    );
    expect(output).not.toContain("[object Object]");
  });

  it.each([
    { item: { full_name: "org/repo", name: "repo" }, expected: "org/repo" },
    {
      item: { sourcePath: "https://github.com/org/repo/blob/main/README.md" },
      expected: "https://github.com/org/repo/blob/main/README.md",
    },
  ])("names the failed $expected", async ({ item, expected }) => {
    await parallelProcess({
      items: [item],
      processFn: async () => {
        throw new Error("Something exploded");
      },
    });
    const output = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain(`${expected}: Something exploded`);
  });
});

describe("processInParallel()", () => {
  it("runs at most `concurrencyLimit` items at once and keeps item order", async () => {
    let active = 0;
    let maxActive = 0;

    const { results, errors } = await Effect.runPromise(
      processInParallel({
        items: [1, 2, 3, 4, 5, 6],
        concurrencyLimit: 2,
        processFn: (item) =>
          Effect.gen(function* () {
            active++;
            maxActive = Math.max(maxActive, active);
            // Earlier items take longer, order must not depend on completion order
            yield* Effect.sleep(10 * (7 - item));
            active--;
            return item * 10;
          }),
      }),
    );

    expect(maxActive).toBe(2);
    expect(results).toEqual([10, 20, 30, 40, 50, 60]);
    expect(errors).toEqual([]);
  });

  it("collects failures with their item and still processes the other items", async () => {
    const { results, errors } = await Effect.runPromise(
      processInParallel({
        items: ["a", "bad", "c"],
        processFn: (item) =>
          item === "bad" ? Effect.fail(new Error("Something exploded")) : Effect.succeed(item),
      }),
    );

    expect(results).toEqual(["a", "c"]);
    expect(errors).toEqual([{ item: "bad", error: new Error("Something exploded") }]);
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("bad: Something exploded");
  });
});

describe("getSampleRate()", () => {
  it("defaults to 1", () => {
    expect(getSampleRate(undefined)).toBe(1);
    expect(getSampleRate("")).toBe(1);
  });

  it("parses valid rates", () => {
    expect(getSampleRate("0.1")).toBe(0.1);
    expect(getSampleRate("0")).toBe(0);
    expect(getSampleRate("1")).toBe(1);
  });

  it("reads LINK_CHECK_SAMPLE_RATE", () => {
    vi.stubEnv("LINK_CHECK_SAMPLE_RATE", "0.25");
    expect(getSampleRate()).toBe(0.25);
  });

  it.each(["abc", "-0.1", "1.5", "NaN"])("throws for invalid rate %s", (value) => {
    expect(() => getSampleRate(value)).toThrow("LINK_CHECK_SAMPLE_RATE");
  });
});

describe("sampleItems()", () => {
  const items = Array.from(
    { length: 100 },
    (_, i) => `https://example.com/page-${String(i).padStart(3, "0")}`,
  );
  const shuffled = items.toReversed();

  it("returns all items with rate 1", () => {
    expect(sampleItems({ items: shuffled, key: (x) => x, rate: 1 })).toEqual(shuffled);
  });

  it("returns every Nth item of the sorted list", () => {
    const sample = sampleItems({ items: shuffled, key: (x) => x, rate: 0.1 });
    expect(sample).toHaveLength(10);
    expect(sample).toEqual(items.filter((_, i) => i % 10 === 0));
  });

  it("is deterministic regardless of the input order", () => {
    const a = sampleItems({ items, key: (x) => x, rate: 0.3 });
    const b = sampleItems({ items: shuffled, key: (x) => x, rate: 0.3 });
    expect(a).toEqual(b);
    expect(a).toHaveLength(30);
  });

  it("returns at least one item", () => {
    expect(sampleItems({ items, key: (x) => x, rate: 0 })).toHaveLength(1);
    expect(sampleItems({ items: ["only"], key: (x) => x, rate: 0.01 })).toEqual(["only"]);
    expect(sampleItems({ items: [], key: (x: string) => x, rate: 0.5 })).toEqual([]);
  });

  it("logs the sample size", () => {
    sampleItems({ items, key: (x) => x, rate: 0.1 });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Sampling 10 of 100 pages"));
  });

  it("uses LINK_CHECK_SAMPLE_RATE by default", () => {
    vi.stubEnv("LINK_CHECK_SAMPLE_RATE", "0.5");
    expect(sampleItems({ items, key: (x) => x })).toHaveLength(50);
  });
});
