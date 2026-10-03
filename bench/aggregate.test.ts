import { describe, expect, it } from "vitest";
import { aggregateRounds } from "./aggregate";
import type { RoundResult } from "./runner";

const round = (
  totalMs: number,
  phases: Array<[string, number]>,
  counters: Record<string, number> = {},
): RoundResult => ({
  totalMs,
  metrics: { phases: phases.map(([name, ms]) => ({ name, ms })), counters },
  outcomeByHref: new Map(),
});

describe("aggregateRounds()", () => {
  it("reports median, min and max of the total time and every phase across rounds", () => {
    const rounds = [
      round(1000, [["Check links", 400]]),
      round(2000, [["Check links", 800]]),
      round(3000, [["Check links", 1200]]),
    ];
    const stats = aggregateRounds(rounds);
    expect(stats.totalMs).toEqual({ median: 2000, min: 1000, max: 3000 });
    expect(stats.phaseMs["Check links"]).toEqual({ median: 800, min: 400, max: 1200 });
  });

  it("treats a phase or counter missing from a round as 0 for it", () => {
    const rounds = [
      round(1000, [["Re-check links with Playwright", 500]], { playwrightNavigations: 2 }),
      round(1000, []), // no Playwright phase or navigations this round
    ];
    const stats = aggregateRounds(rounds);
    expect(stats.phaseMs["Re-check links with Playwright"]).toEqual({
      median: 250,
      min: 0,
      max: 500,
    });
    expect(stats.counters.playwrightNavigations).toEqual({ median: 1, min: 0, max: 2 });
  });
});
