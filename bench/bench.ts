/**
 * Speed benchmark: checks the links of `bench/corpus.json`, optionally A/B against another checkout.
 * See the "Benchmark" section of README.md.
 *
 *   pnpm bench                     benchmark the current tree
 *   pnpm bench --base <dir>        A/B against another checkout (e.g. a `git worktree` of main)
 *   pnpm bench --rounds <n>        rounds per side (default: 2 with --base, 1 without)
 *
 * Every round runs in its own process (`--round`, internal), so base and head never share module-level state.
 * With `--base`, the base and head round of a pair run concurrently: rounds mostly wait on the network and
 * 15s anchor timeouts (little CPU contention), and both sides see the same network conditions at the same
 * moment. Halves the CI time too.
 * Only imports from `../src` and Node built-ins: for a base round this file and the corpus are copied to
 * `<dir>/.bench/` and run there, so `../src` resolves to the base's code.
 */
import { spawn } from "node:child_process";
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

// `outcomes`: href -> "ok" or the error kind
type Round = { totalMs: number; metrics: RunMetrics; outcomes: Record<string, string> };
type Stat = { median: number; min: number; max: number };
type Verdict = "better" | "worse" | "same";

const ICON = { better: "🟢", worse: "🔴", same: "⚪" } as const;
// Hidden marker, the workflow uses it to find and update its own PR comment
const MARKER = "<!-- docs-link-checker-benchmark -->";
const TOTAL = "**Total time**";
const MAX_CHANGED_LINES = 50;
const REPORT_FILE = "results/bench/benchmark.md";

// A time diff must be both noticeable (relative) and meaningful (absolute), live sites are noisy
const TIME_RELATIVE = 0.15;
const TIME_ABSOLUTE_MS = 5000;

const isRound = (value: unknown): value is Round =>
  typeof value === "object" &&
  value !== null &&
  "totalMs" in value &&
  "metrics" in value &&
  "outcomes" in value;

const runRound = async (outFile: string) => {
  const start = performance.now();
  const outcomes: Record<string, string> = {};
  const metrics = await withRun({}, async () => {
    const results = await checkLinks({ links: corpus });
    const context = getRunContext();
    if (!context) {
      throw new Error("No run context inside withRun");
    }
    // Counted like the other counters, so the report shows if a speed change altered results
    for (const { href, result } of results) {
      const outcome = result.ok ? "ok" : result.error;
      outcomes[href] = outcome;
      const name = `result: ${outcome}`;
      context.metrics.counters[name] = (context.metrics.counters[name] ?? 0) + 1;
    }
    return context.metrics;
  });
  const round: Round = { totalMs: performance.now() - start, metrics, outcomes };
  writeFileSync(outFile, JSON.stringify(round));
};

/** Copies this script and the corpus into the checkout, so `../src` resolves to its code */
const installBench = (dir: string) => {
  const benchDir = join(resolve(dir), ".bench");
  mkdirSync(benchDir, { recursive: true });
  copyFileSync(import.meta.filename, join(benchDir, "bench.ts"));
  copyFileSync(join(import.meta.dirname, "corpus.json"), join(benchDir, "corpus.json"));
};

/** Runs one round in a new process with the code (and `node_modules`) of `dir`, `undefined` is this tree */
const spawnRound = async (dir: string | undefined, outFile: string): Promise<Round> => {
  // Absolute because `cwd` changes to the checkout
  const cwd = dir ? resolve(dir) : resolve(import.meta.dirname, "..");
  const script = dir ? join(cwd, ".bench", "bench.ts") : import.meta.filename;
  // Stdout is noise when rounds run at the same time, stderr (errors) stays visible
  const child = spawn(join(cwd, "node_modules", ".bin", "tsx"), [script, "--round", outFile], {
    cwd,
    stdio: ["ignore", "ignore", "inherit"],
  });
  await new Promise<void>((done, fail) => {
    child.once("error", fail);
    child.once("close", (code) =>
      code === 0 ? done() : fail(new Error(`Benchmark round failed (exit code ${code})`)),
    );
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

// More `ok` results is better, for the other counters fewer is better
const counterVerdictOf = (name: string, base: Stat, head: Stat): Verdict =>
  name === "ok" ? counterVerdict(head, base) : counterVerdict(base, head);

const formatMs = (ms: number) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
const format = (s: Stat, fmt: (n: number) => string) =>
  s.min === s.max ? fmt(s.median) : `${fmt(s.median)} (${fmt(s.min)}-${fmt(s.max)})`;

/** Hrefs with a different outcome in every round pair, so one-off network flakes are left out */
const changedResults = (head: Round[], base: Round[]): string[] =>
  Object.keys(head[0]?.outcomes ?? {})
    .filter((href) => head.every((round, i) => round.outcomes[href] !== base[i]?.outcomes[href]))
    .map((href) => `- ${href}: ${base[0]?.outcomes[href]} → ${head[0]?.outcomes[href]}`);

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
      const v = isTime ? timeVerdict(b, h) : counterVerdictOf(name, b, h);
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
  const changed = base ? changedResults(head, base) : [];
  const changedSection = changed.length
    ? [
        "",
        "### Changed results",
        "",
        ...changed.slice(0, MAX_CHANGED_LINES),
        ...(changed.length > MAX_CHANGED_LINES
          ? [`- ...and ${changed.length - MAX_CHANGED_LINES} more`]
          : []),
      ]
    : [];
  return [MARKER, headline, "", ...columns, ...rows, ...changedSection, ""].join("\n");
};

const main = async () => {
  const { values, positionals } = parseArgs({
    options: {
      base: { type: "string" },
      rounds: { type: "string" },
      round: { type: "boolean" },
    },
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
    if (values.base) {
      installBench(values.base);
    }
    // Pairs run one after another (interleaved), so slow network phases hit both sides alike
    for (let i = 1; i <= rounds; i++) {
      console.log(`Round ${i}/${rounds}: ${values.base ? "base + head" : "head"}`);
      const [baseRound, headRound] = await Promise.all([
        values.base ? spawnRound(values.base, join(tmpDir, `base-${i}.json`)) : undefined,
        spawnRound(undefined, join(tmpDir, `head-${i}.json`)),
      ]);
      if (baseRound) {
        base.push(baseRound);
      }
      head.push(headRound);
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
