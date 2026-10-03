import type { RoundResult } from "./runner";
import { type Stat, summarize } from "./verdict";

export type AggregatedSide = {
  totalMs: Stat;
  phaseMs: Record<string, Stat>;
  counters: Record<string, Stat>;
};

/** Combines every metric name seen across rounds (a counter or phase can be absent in some rounds, e.g. 0 navigations) */
const allKeys = <T>(rounds: T[][], key: (item: T) => string): string[] => [
  ...new Set(rounds.flatMap((items) => items.map(key))),
];

/**
 * Median, min and max of each phase and counter across `rounds` (at least one). A phase or counter missing from a
 * round counts as 0 for it (e.g. "Playwright hash fallbacks" when a round had none).
 */
export const aggregateRounds = (rounds: RoundResult[]): AggregatedSide => {
  const phaseNames = allKeys(
    rounds.map((round) => round.metrics.phases),
    (phase) => phase.name,
  );
  const counterNames = allKeys(
    rounds.map((round) => Object.keys(round.metrics.counters)),
    (name) => name,
  );
  const phaseMs: Record<string, Stat> = {};
  for (const name of phaseNames) {
    phaseMs[name] = summarize(
      rounds.map((round) => round.metrics.phases.find((phase) => phase.name === name)?.ms ?? 0),
    );
  }
  const counters: Record<string, Stat> = {};
  for (const name of counterNames) {
    counters[name] = summarize(rounds.map((round) => round.metrics.counters[name] ?? 0));
  }
  return {
    totalMs: summarize(rounds.map((round) => round.totalMs)),
    phaseMs,
    counters,
  };
};
