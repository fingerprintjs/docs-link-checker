/**
 * One benchmark round: checks the links of `corpus.json` and writes the result as JSON to the given file.
 * Run by `bench.ts`, in this checkout or in the base checkout of an A/B run (copied to `<dir>/.bench/`).
 * - Only Node built-ins and dynamic imports of `../src`: the base can have a different API, `runRound` knows the
 *   current one (`src/app.ts`, Effect) and the one before it (`src/run.ts`).
 * - The result shape is validated by `RoundSchema` in `bench.ts`.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import corpus from "./corpus.json";

type RunMetrics = {
  readonly counters: Readonly<Record<string, number>>;
  readonly phases: ReadonlyArray<{ readonly name: string; readonly ms: number }>;
};
/** `outcomes`: href -> "ok" or the error kind */
export type Round = {
  readonly totalMs: number;
  readonly metrics: RunMetrics;
  readonly outcomes: Readonly<Record<string, string>>;
};

/** Adds a `result: <outcome>` counter per outcome, so the report shows if a speed change altered results */
const withResultCounters = (
  metrics: RunMetrics,
  results: ReadonlyArray<{ href: string; result: { ok: boolean; error?: string } }>,
): { metrics: RunMetrics; outcomes: Record<string, string> } => {
  const counters = { ...metrics.counters };
  const outcomes: Record<string, string> = {};
  for (const { href, result } of results) {
    const outcome = result.ok ? "ok" : (result.error ?? "error");
    outcomes[href] = outcome;
    counters[`result: ${outcome}`] = (counters[`result: ${outcome}`] ?? 0) + 1;
  }
  return { metrics: { counters, phases: metrics.phases }, outcomes };
};

const runCurrent = async () => {
  const { Effect } = await import("effect");
  const { runLive } = await import("../src/app");
  const { checkLinks } = await import("../src/link");
  const { Metrics } = await import("../src/metrics");
  return runLive(
    Effect.gen(function* () {
      const results = yield* checkLinks({ links: corpus });
      const metrics = yield* (yield* Metrics).snapshot;
      return withResultCounters(metrics, results);
    }),
  );
};

// TODO: remove once main has the Effect version (`src/app.ts`), then `--base` needs no fallback
type LegacyRun = {
  withRun: <T>(config: object, fn: () => Promise<T>) => Promise<T>;
  getRunContext: () => { metrics: RunMetrics } | undefined;
};
const runLegacy = async () => {
  // Variable paths: these modules exist only in checkouts before the Effect rewrite
  const runPath = "../src/run";
  const linkPath = "../src/link";
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shape of the old API, see `LegacyRun`
  const { withRun, getRunContext } = (await import(runPath)) as LegacyRun;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shape of the old API
  const { checkLinks } = (await import(linkPath)) as {
    checkLinks: (args: {
      links: typeof corpus;
    }) => Promise<Parameters<typeof withResultCounters>[1]>;
  };
  return withRun({}, async () => {
    const results = await checkLinks({ links: corpus });
    const metrics = getRunContext()?.metrics;
    if (!metrics) {
      throw new Error("No run context inside withRun");
    }
    return withResultCounters(metrics, results);
  });
};

const runRound = async (outFile: string) => {
  const start = performance.now();
  const { metrics, outcomes } = await (existsSync(join(import.meta.dirname, "..", "src", "app.ts"))
    ? runCurrent()
    : runLegacy());
  const round: Round = { totalMs: performance.now() - start, metrics, outcomes };
  writeFileSync(outFile, JSON.stringify(round));
};

const [outFile] = process.argv.slice(2);
if (!outFile) {
  throw new Error("Usage: round.ts <outFile>");
}
await runRound(outFile);
