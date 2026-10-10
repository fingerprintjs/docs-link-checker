import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { withRun } from "./run";
import { createTerminal } from "./terminal";
import { getSampleRate, parallelProcess, sampleItems } from "./utils";

let errorSpy: MockInstance<typeof console.error>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("parallelProcess() progress", () => {
  const output = async (
    run: () => Promise<unknown>,
    { verbose = false, now }: { verbose?: boolean; now?: () => number } = {},
  ) => {
    let text = "";
    const terminal = createTerminal({
      now,
      write: (chunk) => {
        text += chunk;
      },
      stream: process.stdout,
      tty: false,
      verbose,
    });
    await withRun({ terminal }, run);
    return stripVTControlCharacters(text);
  };
  const items = Array.from({ length: 20 }, (_, i) => i);

  it("shows the progress of a labelled batch every 10% with the failing count", async () => {
    let done = 0;
    // Every clock read is 10s later: each progress update is past the quiet start of the step
    let time = 0;
    const text = await output(
      () =>
        parallelProcess({
          items,
          label: "Checking",
          concurrencyLimit: 1,
          failing: () => done,
          processFn: async (item) => {
            done = item;
          },
        }),
      { now: () => (time += 10_000) },
    );
    expect(text).toContain("Checking 50% (10/20, 9 failing so far)\n");
    expect(text.match(/Checking \d+%/g)).toHaveLength(10);
  });

  it("starts the step clock with the batch, not with the first finished item", async () => {
    let time = 0;
    const text = await output(
      () =>
        parallelProcess({
          items: [1],
          label: "Checking",
          processFn: async () => {
            time = 6000;
          },
        }),
      { now: () => time },
    );
    expect(text).toContain("Checking 100% (1/1)\n");
  });

  it("prints no progress lines for a batch that ends within seconds", async () => {
    const text = await output(() =>
      parallelProcess({ items, label: "Checking", processFn: async () => {} }),
    );
    expect(text).not.toMatch(/Checking \d+%/);
  });

  it("shows nothing without a label, and the time of the batch only with --verbose", async () => {
    const run = () => parallelProcess({ items, processFn: async () => {} });
    expect(await output(run)).toBe("");
    expect(await output(run, { verbose: true })).toMatch(/^Batch: 20 items in \d+ms\n/);
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

  it("shows the sample size", async () => {
    let text = "";
    const terminal = createTerminal({
      write: (chunk) => {
        text += chunk;
      },
      stream: process.stdout,
      tty: false,
    });
    await withRun({ terminal }, async () => sampleItems({ items, key: (x) => x, rate: 0.1 }));
    expect(stripVTControlCharacters(text)).toBe("Sampling 10 of 100 pages (sample rate 0.1)\n");
  });

  it("uses LINK_CHECK_SAMPLE_RATE by default", () => {
    vi.stubEnv("LINK_CHECK_SAMPLE_RATE", "0.5");
    expect(sampleItems({ items, key: (x) => x })).toHaveLength(50);
  });
});
