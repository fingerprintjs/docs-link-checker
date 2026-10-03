import { pathToFileURL } from "node:url";
import type { checkLinks as CheckLinksFn } from "../src/link";
import type {
  getRunContext as GetRunContextFn,
  RunMetrics,
  withRun as WithRunFn,
} from "../src/run";
import type { Link, LinkWithResult } from "../src/types";
import type { CorpusLink } from "./types";

/**
 * The only entry points a benchmark round relies on, loaded either from the current tree or (with `--base`) from
 * another checkout, see `loadEntrypoints`. Kept to a minimal, stable surface so an older `--base` checkout (without
 * `checkedWith` on its results, or without `bench/` at all) still runs.
 */
export type Entrypoints = {
  withRun: typeof WithRunFn;
  getRunContext: typeof GetRunContextFn;
  checkLinks: typeof CheckLinksFn;
};

/** Narrows a dynamically imported module to an object with string keys, so its exports can be looked up by name */
const isModuleRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isCallable = (value: unknown): value is (...args: never[]) => unknown =>
  typeof value === "function";

/**
 * Looks up `name` in a dynamically imported module and checks it is a function, so `loadEntrypoints` fails with a
 * clear error instead of a confusing crash deep inside a round when `--base` points at an incompatible checkout.
 */
const requireFunctionExport = (
  module: unknown,
  name: string,
  source: string,
): ((...args: never[]) => unknown) => {
  const value = isModuleRecord(module) ? module[name] : undefined;
  if (!isCallable(value)) {
    throw new TypeError(`${source} does not export a function named "${name}".`);
  }
  return value;
};

/**
 * Loads `withRun`, `getRunContext` and `checkLinks` from `dir` (a checkout of the repository), or from the current
 * tree when `dir` is omitted. The runner (this file and the rest of `bench/`) always comes from the current tree:
 * only these three functions are loaded from `--base`, so the benchmark still works against a base checkout that
 * predates `bench/`.
 */
export const loadEntrypoints = async (dir?: string): Promise<Entrypoints> => {
  const base = dir ? `${pathToFileURL(dir).href}/` : "../";
  const runSource = `${base}src/run.ts`;
  const linkSource = `${base}src/link.ts`;
  const run: unknown = await import(runSource);
  const link: unknown = await import(linkSource);
  const withRun = requireFunctionExport(run, "withRun", runSource);
  const getRunContext = requireFunctionExport(run, "getRunContext", runSource);
  const checkLinks = requireFunctionExport(link, "checkLinks", linkSource);
  // A dynamic import can't be checked against the exact call signature at runtime, only that it is a function
  // (checked above, like `run.ts`'s own `runCached` cache, see its comment): these three names are the whole
  // contract with `--base`, and a round fails fast and clearly if a checkout's shape doesn't match.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- checked to be a function above, the exact signature of a dynamic import can't be checked at runtime
  return { withRun, getRunContext, checkLinks } as Entrypoints;
};

export type RoundResult = {
  totalMs: number;
  /** Phase durations (ms) and counters recorded by the run, see `src/run.ts` */
  metrics: RunMetrics;
  /** Outcome ("ok" or the error kind) by href, for the correctness check */
  outcomeByHref: Map<string, string>;
};

const outcomeOf = (link: LinkWithResult): string => (link.result.ok ? "ok" : link.result.error);

/**
 * Runs one benchmark round: checks `links` with `entry.checkLinks`, inside a fresh `withRun` (fresh caches, host
 * limiter and browser), and reads the run metrics before the run (and its browser) closes.
 */
export const runRound = async (entry: Entrypoints, links: Link[]): Promise<RoundResult> => {
  const start = performance.now();
  const { results, metrics } = await entry.withRun({}, async () => {
    const roundResults = await entry.checkLinks({ links });
    const context = entry.getRunContext();
    if (!context) {
      throw new Error("No run context inside withRun, this should never happen.");
    }
    return { results: roundResults, metrics: context.metrics };
  });
  return {
    totalMs: performance.now() - start,
    metrics,
    outcomeByHref: new Map(results.map((link) => [link.href, outcomeOf(link)])),
  };
};

/** `Link`s to feed `checkLinks` with, stripped of the corpus' recorded outcome and check method */
export const linksOf = (corpusLinks: CorpusLink[]): Link[] =>
  corpusLinks.map(({ page, href, text }) => ({ page, href, text }));
