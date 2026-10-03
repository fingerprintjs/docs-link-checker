import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RunMetrics } from "../src/run";
import type { Link } from "../src/types";
import type { CorpusLink } from "./types";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const ROUND_SCRIPT = join(import.meta.dirname, "round.ts");

export type RoundResult = {
  totalMs: number;
  /** Phase durations (ms) and counters recorded by the run, see `src/run.ts` */
  metrics: RunMetrics;
  /** Outcome ("ok" or the error kind) by href, for the correctness check */
  outcomeByHref: Map<string, string>;
};

/** Shape `bench/round.ts` writes to its output file, before `outcomeByHref` is turned into a `Map` */
type RawRoundResult = {
  totalMs: number;
  metrics: RunMetrics;
  outcomeByHref: Array<[string, string]>;
};

const isRawRoundResult = (value: unknown): value is RawRoundResult =>
  typeof value === "object" &&
  value !== null &&
  "totalMs" in value &&
  "metrics" in value &&
  "outcomeByHref" in value;

const resolveTsxBin = (dir: string): string => {
  const bin = join(dir, "node_modules", ".bin", "tsx");
  if (!existsSync(bin)) {
    throw new Error(`${bin} not found, run "pnpm install" in ${dir} first.`);
  }
  return bin;
};

/**
 * Copies `bench/round.ts` into `<dir>/.bench/round.ts` so it runs there against that checkout's own `src` and
 * `node_modules`, instead of this tree's. Returns the script path to run, and the directory to run it from.
 */
const prepareRound = (dir: string | undefined): { scriptPath: string; workDir: string } => {
  if (!dir) {
    return { scriptPath: ROUND_SCRIPT, workDir: PROJECT_ROOT };
  }
  // Absolute: the round runs with `cwd` set to the checkout, a relative `dir` would then resolve twice
  const workDir = resolve(dir);
  const targetDir = join(workDir, ".bench");
  mkdirSync(targetDir, { recursive: true });
  const scriptPath = join(targetDir, "round.ts");
  copyFileSync(ROUND_SCRIPT, scriptPath);
  return { scriptPath, workDir };
};

/**
 * Runs one benchmark round as its own process: checks `links` with the code at `dir` (the current tree when
 * `dir` is omitted), inside a fresh `withRun` (fresh caches, host limiter and browser), see `bench/round.ts`.
 * A separate process per round (rather than two dynamic imports of base and head in one process) keeps module-level
 * state (the shared page-slot semaphore in `src/browser.ts`, sitemap fetch limits...) of one side from leaking into
 * the other and biasing the comparison.
 */
export const runRound = (dir: string | undefined, links: Link[]): RoundResult => {
  const { scriptPath, workDir } = prepareRound(dir);
  const tsxBin = resolveTsxBin(workDir);
  const tmpDir = mkdtempSync(join(tmpdir(), "docs-link-checker-bench-"));
  const linksFile = join(tmpDir, "links.json");
  const outputFile = join(tmpDir, "result.json");
  writeFileSync(linksFile, JSON.stringify(links));
  try {
    execFileSync(tsxBin, [scriptPath, linksFile, outputFile], { stdio: "inherit", cwd: workDir });
    const raw: unknown = JSON.parse(readFileSync(outputFile, "utf8"));
    if (!isRawRoundResult(raw)) {
      throw new Error(`${outputFile} is not a valid round result.`);
    }
    return {
      totalMs: raw.totalMs,
      metrics: raw.metrics,
      outcomeByHref: new Map(raw.outcomeByHref),
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
};

/** `Link`s to feed a round with, stripped of the corpus' recorded outcome and check method */
export const linksOf = (corpusLinks: CorpusLink[]): Link[] =>
  corpusLinks.map(({ page, href, text }) => ({ page, href, text }));
