/**
 * Speed benchmark CLI: checks the links of `bench/corpus.json` with the current tree, optionally A/B against
 * another checkout (`--base <dir>`, e.g. a `git worktree` of `main`). See the "Benchmark" section of README.md.
 *
 * Usage:
 *   pnpm bench                        Benchmark the current tree, print a summary
 *   pnpm bench --base <dir>           A/B against another checkout, interleaved rounds, with a verdict
 *   pnpm bench --rounds <n>           Rounds per side (default: 2 with --base, 1 without)
 *   pnpm bench --output-dir <dir>     Where to write the JSON result (default: results/bench)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { aggregateRounds } from "./aggregate";
import { type CorrectnessEntry, renderReport } from "./report";
import { linksOf, type RoundResult, runRound } from "./runner";
import type { Corpus } from "./types";

const DEFAULT_OUTPUT_DIR = "results/bench";
const CORPUS_FILE = join(import.meta.dirname, "corpus.json");

/** Narrow, structural check that `JSON.parse`d `value` has the shape of a `Corpus` (our own generated file) */
const isCorpus = (value: unknown): value is Corpus =>
  typeof value === "object" &&
  value !== null &&
  "links" in value &&
  Array.isArray(value.links) &&
  "generatedAt" in value &&
  "gitSha" in value &&
  "sampleRate" in value &&
  "population" in value &&
  "sample" in value;

const loadCorpus = (): Corpus => {
  const data: unknown = JSON.parse(readFileSync(CORPUS_FILE, "utf8"));
  if (!isCorpus(data)) {
    throw new Error(`${CORPUS_FILE} is not a valid corpus file, run "pnpm bench:corpus" first.`);
  }
  return data;
};

/** Hrefs whose recorded outcome differs from `actualByHref` (see `ReportInput.correctness`) */
const diffOutcomes = (
  expectedByHref: Map<string, string>,
  actualByHref: Map<string, string>,
): CorrectnessEntry[] => {
  const entries: CorrectnessEntry[] = [];
  for (const [href, expected] of expectedByHref) {
    const actual = actualByHref.get(href);
    if (actual !== undefined && actual !== expected) {
      entries.push({ href, expected, actual });
    }
  }
  return entries.toSorted((a, b) => a.href.localeCompare(b.href));
};

type CliOptions = { base?: string; rounds: number; outputDir: string };

const parseCliArgs = (argv: string[]): CliOptions => {
  const { values } = parseArgs({
    args: argv,
    options: {
      base: { type: "string" },
      rounds: { type: "string" },
      "output-dir": { type: "string" },
    },
  });
  let rounds = values.base ? 2 : 1;
  if (values.rounds) {
    rounds = Number(values.rounds);
  }
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new Error(`Invalid --rounds "${values.rounds}", expected a positive integer.`);
  }
  return { base: values.base, rounds, outputDir: values["output-dir"] ?? DEFAULT_OUTPUT_DIR };
};

const main = () => {
  const options = parseCliArgs(process.argv.slice(2));
  const corpus = loadCorpus();
  const links = linksOf(corpus.links);
  const corpusInfo = {
    generatedAt: corpus.generatedAt,
    gitSha: corpus.gitSha,
    sampleRate: corpus.sampleRate,
    population: corpus.population,
    sample: corpus.sample,
    missingSources: corpus.missingSources ?? [],
  };

  console.log(
    options.base
      ? `Running ${options.rounds} interleaved round(s) of base vs head on ${links.length} links...`
      : `Running ${options.rounds} round(s) on ${links.length} links...`,
  );

  const headRounds: RoundResult[] = [];
  const baseRounds: RoundResult[] = [];
  // Interleaved (base, head, base, head...), each round its own process (see runRound), so both sides see
  // similar network conditions and neither leaks module-level state into the other.
  for (let i = 0; i < options.rounds; i++) {
    if (options.base) {
      console.log(`Round ${i + 1}/${options.rounds}: base...`);
      baseRounds.push(runRound(options.base, links));
    }
    console.log(`Round ${i + 1}/${options.rounds}: head...`);
    headRounds.push(runRound(undefined, links));
  }

  const headStats = aggregateRounds(headRounds);
  const lastHeadRound = headRounds[headRounds.length - 1];
  if (!lastHeadRound) {
    throw new Error("No round ran, this should never happen (rounds >= 1 is validated above).");
  }

  const correctness = options.base
    ? diffOutcomes(
        baseRounds[baseRounds.length - 1]?.outcomeByHref ?? new Map<string, string>(),
        lastHeadRound.outcomeByHref,
      )
    : diffOutcomes(
        new Map(corpus.links.map((link) => [link.href, link.outcome])),
        lastHeadRound.outcomeByHref,
      );

  const report = renderReport({
    rounds: options.rounds,
    corpus: corpusInfo,
    head: headStats,
    base: options.base ? aggregateRounds(baseRounds) : undefined,
    correctness,
  });

  console.log(report);
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    writeFileSync(summaryFile, report, { flag: "a" });
  }

  mkdirSync(options.outputDir, { recursive: true });
  // The markdown file is what CI posts as the sticky PR comment (see .github/workflows/benchmark.yaml)
  const markdownPath = join(options.outputDir, "benchmark.md");
  writeFileSync(markdownPath, report);
  const resultPath = join(options.outputDir, "benchmark.json");
  writeFileSync(
    resultPath,
    `${JSON.stringify({ corpus: corpusInfo, headRounds, baseRounds, correctness }, null, 2)}\n`,
  );
  console.log(`Wrote ${markdownPath} and ${resultPath}`);
};

main();
