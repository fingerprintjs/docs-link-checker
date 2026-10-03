import { describe, expect, it } from "vitest";
import type { AggregatedSide } from "./aggregate";
import { COMMENT_MARKER } from "./comment_marker";
import { renderReport } from "./report";

const stat = (median: number, min = median, max = median) => ({ median, min, max });

const side = (
  totalMs: number,
  phaseMs: Record<string, number> = {},
  counters: Record<string, number> = {},
): AggregatedSide => ({
  totalMs: stat(totalMs),
  phaseMs: Object.fromEntries(Object.entries(phaseMs).map(([name, value]) => [name, stat(value)])),
  counters: Object.fromEntries(
    Object.entries(counters).map(([name, value]) => [name, stat(value)]),
  ),
});

const composition = (linkCount: number) => ({
  linkCount,
  uniqueUrlCount: linkCount,
  pageCount: linkCount,
  bySource: { docs: linkCount },
  byCheckedWith: { fetch: linkCount },
});

const corpus = {
  generatedAt: "2026-01-01T00:00:00.000Z",
  gitSha: "abcdef0123456",
  sampleRate: 0.1,
  population: composition(100),
  sample: composition(10),
};

describe("renderReport()", () => {
  it("starts with the hidden comment marker, so CI can find and update its own sticky comment", () => {
    const report = renderReport({ rounds: 1, corpus, head: side(1000), correctness: [] });
    expect(report.startsWith(COMMENT_MARKER)).toBe(true);
  });

  it("reports a slower head as slower, with a comparison table against base", () => {
    const report = renderReport({
      rounds: 2,
      corpus,
      base: side(10_000, { "Check links": 5000 }),
      head: side(20_000, { "Check links": 15_000 }),
      correctness: [],
    });
    expect(report).toContain("worse");
    expect(report).toContain("🔴");
    expect(report).toContain("Check links");
  });

  it("reports no significant change when within thresholds", () => {
    const report = renderReport({
      rounds: 2,
      corpus,
      base: side(10_000),
      head: side(10_100),
      correctness: [],
    });
    expect(report).toContain("no significant change");
  });

  it("renders a solo summary (no verdict) without --base", () => {
    const report = renderReport({ rounds: 1, corpus, head: side(5000), correctness: [] });
    expect(report).not.toContain("Base");
    expect(report).toContain("current tree");
  });

  it("lists correctness differences as possible flakiness, not failures", () => {
    const report = renderReport({
      rounds: 1,
      corpus,
      head: side(1000),
      correctness: [{ href: "https://example.com/a", expected: "ok", actual: "broken link" }],
    });
    expect(report).toContain("Possible flakiness");
    expect(report).toContain("https://example.com/a");
  });

  it("reports no differences when the correctness list is empty", () => {
    const report = renderReport({ rounds: 1, corpus, head: side(1000), correctness: [] });
    expect(report).toContain("No outcome differences");
  });

  it("shows the corpus composition, sample next to the full population", () => {
    const report = renderReport({ rounds: 1, corpus, head: side(1000), correctness: [] });
    expect(report).toContain("| Links | 100 | 10 |");
    expect(report).toContain("| Source: docs | 100 | 10 |");
    expect(report).toContain("| Checked with: fetch | 100 | 10 |");
  });
});
