/**
 * Speed benchmark: checks the links of `bench/corpus.json`, optionally A/B against another checkout.
 * See the "Benchmark" section of README.md.
 *
 *   pnpm bench                     benchmark the current tree
 *   pnpm bench --base <dir>        A/B against another checkout (e.g. a `git worktree` of main)
 *   pnpm bench --rounds <n>        rounds per side (default: 2 with --base, 1 without)
 *
 * Every round runs in its own process (`--round`, internal), so base and head never share module-level state.
 * Only imports from `../src` and Node built-ins: for a base round this file and the corpus are copied to
 * `<dir>/.bench/` and run there, so `../src` resolves to the base's code.
 */
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkLinks } from "../src/link";
import { getRunContext, type RunMetrics, withRun } from "../src/run";
import corpus from "./corpus.json";

type Round = { totalMs: number; metrics: RunMetrics };
type Stat = { median: number; min: number; max: number };
type Verdict = "better" | "worse" | "same";

const ICON = { better: "🟢", worse: "🔴", same: "⚪" } as const;
// Hidden marker, the workflow uses it to find and update its own PR comment
const MARKER = "<!-- docs-link-checker-benchmark -->";
const TOTAL = "**Total time**";
const REPORT_FILE = "results/bench/benchmark.md";

// A time diff must be both noticeable (relative) and meaningful (absolute), live sites are noisy
const TIME_RELATIVE = 0.15;
const TIME_ABSOLUTE_MS = 5000;

const isRound = (value: unknown): value is Round =>
  typeof value === "object" && value !== null && "totalMs" in value && "metrics" in value;

const runRound = async (outFile: string) => {
  const start = performance.now();
  const metrics = await withRun({}, async () => {
    await checkLinks({ links: corpus });
    const context = getRunContext();
    if (!context) {
      throw new Error("No run context inside withRun");
    }
    return context.metrics;
  });
  const round: Round = { totalMs: performance.now() - start, metrics };
  writeFileSync(outFile, JSON.stringify(round));
};

/** Runs one round in a new process with the code (and `node_modules`) of `dir` */
const spawnRound = (dir: string | undefined, tmpDir: string): Round => {
  let script = import.meta.filename;
  let cwd = resolve(import.meta.dirname, "..");
  if (dir) {
    // Absolute because `cwd` changes to the checkout
    cwd = resolve(dir);
    mkdirSync(join(cwd, ".bench"), { recursive: true });
    script = join(cwd, ".bench", "bench.ts");
    copyFileSync(import.meta.filename, script);
    copyFileSync(join(import.meta.dirname, "corpus.json"), join(cwd, ".bench", "corpus.json"));
  }
  const outFile = join(tmpDir, "round.json");
  execFileSync(join(cwd, "node_modules", ".bin", "tsx"), [script, "--round", outFile], {
    cwd,
    stdio: "inherit",
  });
  const round: unknown = JSON.parse(readFileSync(outFile, "utf8"));
  if (!isRound(round)) {
    throw new Error(`${outFile} is not a valid round result`);
  }
  return round;
};

const stat = (values: number[]): Stat => {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return { median, min: sorted[0] ?? 0, max: sorted.at(-1) ?? 0 };
};

/** Stats per name across rounds, a name missing from a round counts as 0 */
const statsByName = (rounds: Round[], pick: (round: Round) => Record<string, number>) => {
  const perRound = rounds.map(pick);
  const names = new Set(perRound.flatMap((values) => Object.keys(values)));
  return new Map([...names].map((name) => [name, stat(perRound.map((v) => v[name] ?? 0))]));
};

const phasesOf = (round: Round): Record<string, number> =>
  Object.fromEntries(round.metrics.phases.map(({ name, ms }) => [name, ms]));

const timeVerdict = (base: Stat, head: Stat): Verdict => {
  const diff = head.median - base.median;
  const relative = base.median === 0 ? Math.sign(diff) * Infinity : diff / base.median;
  if (diff > TIME_ABSOLUTE_MS && relative > TIME_RELATIVE) {
    return "worse";
  }
  if (diff < -TIME_ABSOLUTE_MS && relative < -TIME_RELATIVE) {
    return "better";
  }
  return "same";
};

// Counts wobble between rounds, so only non-overlapping ranges count as a change
const counterVerdict = (base: Stat, head: Stat): Verdict => {
  if (head.min > base.max) {
    return "worse";
  }
  return head.max < base.min ? "better" : "same";
};

const formatMs = (ms: number) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
const format = (s: Stat, fmt: (n: number) => string) =>
  s.min === s.max ? fmt(s.median) : `${fmt(s.median)} (${fmt(s.min)}-${fmt(s.max)})`;

const reportOf = (head: Round[], base: Round[] | undefined): string => {
  const kinds = [
    { pick: (r: Round) => ({ [TOTAL]: r.totalMs }), isTime: true },
    { pick: phasesOf, isTime: true },
    { pick: (r: Round) => r.metrics.counters, isTime: false },
  ];
  const rows: string[] = [];
  let headline = `## Benchmark: current tree (${head.length} rounds)`;
  for (const { pick, isTime } of kinds) {
    const headStats = statsByName(head, pick);
    const baseStats = base && statsByName(base, pick);
    const fmt = isTime ? formatMs : String;
    for (const name of new Set([...headStats.keys(), ...(baseStats?.keys() ?? [])])) {
      const h = headStats.get(name) ?? stat([0]);
      if (!baseStats) {
        rows.push(`| ${name} | ${format(h, fmt)} |`);
        continue;
      }
      const b = baseStats.get(name) ?? stat([0]);
      const v = isTime ? timeVerdict(b, h) : counterVerdict(b, h);
      rows.push(`| ${name} | ${format(b, fmt)} | ${format(h, fmt)} | ${ICON[v]} ${v} |`);
      if (name === TOTAL) {
        const total = timeVerdict(b, h);
        headline = `## ${ICON[total]} Benchmark: ${total} (${head.length} rounds, interleaved base/head)`;
      }
    }
  }
  const columns = base
    ? ["| Metric | Base | Head | Verdict |", "| --- | ---: | ---: | --- |"]
    : ["| Metric | Head |", "| --- | ---: |"];
  return [MARKER, headline, "", ...columns, ...rows, ""].join("\n");
};

const main = async () => {
  const { values, positionals } = parseArgs({
    options: { base: { type: "string" }, rounds: { type: "string" }, round: { type: "boolean" } },
    allowPositionals: true,
  });
  const [outFile] = positionals;
  if (values.round) {
    if (!outFile) {
      throw new Error("Usage: bench.ts --round <outFile>");
    }
    await runRound(outFile);
    return;
  }

  const rounds = Number(values.rounds ?? (values.base ? 2 : 1));
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new Error(`Invalid --rounds "${values.rounds}", expected a positive integer.`);
  }
  const tmpDir = mkdtempSync(join(tmpdir(), "docs-link-checker-bench-"));
  try {
    const head: Round[] = [];
    const base: Round[] = [];
    // Interleaved so both sides see similar network conditions
    for (let i = 1; i <= rounds; i++) {
      if (values.base) {
        console.log(`Round ${i}/${rounds}: base`);
        base.push(spawnRound(values.base, tmpDir));
      }
      console.log(`Round ${i}/${rounds}: head`);
      head.push(spawnRound(undefined, tmpDir));
    }
    const report = reportOf(head, values.base ? base : undefined);
    console.log(report);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
    }
    mkdirSync(dirname(REPORT_FILE), { recursive: true });
    writeFileSync(REPORT_FILE, report);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
};

await main();
