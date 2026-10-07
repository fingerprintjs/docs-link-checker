import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeItem, getSampleRate, parallelProcess, sampleItems } from "./utils";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("parallelProcess() progress", () => {
  it("logs progress while running and stops when done", async () => {
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
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
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
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

  it("describeItem() handles strings, links and other objects", () => {
    expect(describeItem("https://example.com")).toBe("https://example.com");
    expect(describeItem({ href: "https://a.com" })).toBe("https://a.com");
    expect(describeItem({ name: "repo" })).toBe('{"name":"repo"}');
    expect(describeItem(42)).toBe("42");
    expect(describeItem({ toJSON: () => undefined })).toBe("[object Object]");
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
    expect(sampleItems({ items: shuffled, key: (x) => x, rate: 1 })).toBe(shuffled);
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
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    sampleItems({ items, key: (x) => x, rate: 0.1 });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Sampling 10 of 100 pages"));
  });

  it("uses LINK_CHECK_SAMPLE_RATE by default", () => {
    vi.stubEnv("LINK_CHECK_SAMPLE_RATE", "0.5");
    expect(sampleItems({ items, key: (x) => x })).toHaveLength(50);
  });
});
