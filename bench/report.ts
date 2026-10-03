import type { AggregatedSide } from "./aggregate";
import { COMMENT_MARKER } from "./comment_marker";
import type { Composition } from "./types";
import { type Stat, verdictForTime } from "./verdict";

export type CorrectnessEntry = {
  href: string;
  /** Outcome on the side being compared against (the base, or the corpus' recorded outcome without --base) */
  expected: string;
  actual: string;
};

export type ReportInput = {
  rounds: number;
  corpus: {
    generatedAt: string;
    gitSha: string;
    sampleRate: number;
    /** Composition of every link checked when the corpus was generated, and of the sample committed to it */
    population: Composition;
    sample: Composition;
    /** Sources that could not be collected when the corpus was generated, see `Corpus.missingSources` */
    missingSources: string[];
  };
  head: AggregatedSide;
  /** Only set with `--base`: an A/B comparison, not just a solo report of `head` */
  base?: AggregatedSide;
  /** Hrefs whose outcome differs from the comparison side (base, or the corpus without --base), see `CorrectnessEntry` */
  correctness: CorrectnessEntry[];
};

const formatMs = (ms: number) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
const formatStat = (stat: Stat, format: (value: number) => string) =>
  stat.min === stat.max
    ? format(stat.median)
    : `${format(stat.median)} (${format(stat.min)}-${format(stat.max)})`;

const VERDICT_ICON = { better: "🟢", worse: "🔴", same: "⚪" } as const;

/** One markdown table row comparing a timed metric (phase or total) between base and head */
const timeRow = (label: string, base: Stat, head: Stat): string => {
  const verdict = verdictForTime(base.median, head.median);
  return `| ${label} | ${formatStat(base, formatMs)} | ${formatStat(head, formatMs)} | ${VERDICT_ICON[verdict]} ${verdict} |`;
};

/** One markdown table row comparing a counter: any change is reported, there is no pass/fail threshold for it */
const counterRow = (label: string, base: Stat, head: Stat): string => {
  const diff = head.median - base.median;
  const note = diff === 0 ? "same" : `${diff > 0 ? "+" : ""}${diff}`;
  return `| ${label} | ${formatStat(base, String)} | ${formatStat(head, String)} | ${note} |`;
};

const renderComparison = ({
  rounds,
  head,
  base,
}: ReportInput & { base: AggregatedSide }): string[] => {
  const verdict = verdictForTime(base.totalMs.median, head.totalMs.median);
  const phaseNames = [...new Set([...Object.keys(base.phaseMs), ...Object.keys(head.phaseMs)])];
  const counterNames = [...new Set([...Object.keys(base.counters), ...Object.keys(head.counters)])];
  const zeroStat = { median: 0, min: 0, max: 0 };
  return [
    `## ${VERDICT_ICON[verdict]} Benchmark: ${verdict === "same" ? "no significant change" : verdict} (${rounds} rounds, interleaved base/head)`,
    "",
    "| Metric | Base | Head | Verdict |",
    "| --- | ---: | ---: | --- |",
    timeRow("**Total time**", base.totalMs, head.totalMs),
    ...phaseNames.map((name) =>
      timeRow(name, base.phaseMs[name] ?? zeroStat, head.phaseMs[name] ?? zeroStat),
    ),
    ...counterNames.map((name) =>
      counterRow(name, base.counters[name] ?? zeroStat, head.counters[name] ?? zeroStat),
    ),
    "",
  ];
};

const renderSolo = ({ rounds, head }: ReportInput): string[] => {
  const zeroStat = { median: 0, min: 0, max: 0 };
  return [
    `## Benchmark: current tree (${rounds} round${rounds === 1 ? "" : "s"}, no --base to compare against)`,
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| **Total time** | ${formatStat(head.totalMs, formatMs)} |`,
    ...Object.keys(head.phaseMs).map(
      (name) => `| ${name} | ${formatStat(head.phaseMs[name] ?? zeroStat, formatMs)} |`,
    ),
    ...Object.keys(head.counters).map(
      (name) => `| ${name} | ${formatStat(head.counters[name] ?? zeroStat, String)} |`,
    ),
    "",
  ];
};

/** Markdown table comparing the corpus' sample composition against the full population it was drawn from */
const renderComposition = ({
  sampleRate,
  population,
  sample,
  missingSources,
}: ReportInput["corpus"]): string[] => {
  const sourceNames = [
    ...new Set([...Object.keys(population.bySource), ...Object.keys(sample.bySource)]),
  ];
  const checkedWithNames = [
    ...new Set([...Object.keys(population.byCheckedWith), ...Object.keys(sample.byCheckedWith)]),
  ];
  return [
    ...(missingSources.length > 0
      ? [
          `⚠️ Missing source(s) in this corpus: ${missingSources.join(", ")} (could not be collected when it was generated, see the corpus generation log). Add the \`refresh-bench-corpus\` label to a PR to regenerate it in CI.`,
          "",
        ]
      : []),
    `<details><summary>Corpus composition (sample rate ${sampleRate}): sample vs the full population it was drawn from</summary>`,
    "",
    "| | Population | Sample |",
    "| --- | ---: | ---: |",
    `| Links | ${population.linkCount} | ${sample.linkCount} |`,
    `| Unique URLs | ${population.uniqueUrlCount} | ${sample.uniqueUrlCount} |`,
    `| Pages (URL without hash) | ${population.pageCount} | ${sample.pageCount} |`,
    ...sourceNames.map(
      (name) =>
        `| Source: ${name} | ${population.bySource[name] ?? 0} | ${sample.bySource[name] ?? 0} |`,
    ),
    ...checkedWithNames.map(
      (name) =>
        `| Checked with: ${name} | ${population.byCheckedWith[name] ?? 0} | ${sample.byCheckedWith[name] ?? 0} |`,
    ),
    "",
    "</details>",
    "",
  ];
};

const renderCorrectness = (correctness: CorrectnessEntry[], comparedTo: string): string[] => {
  if (correctness.length === 0) {
    return [`No outcome differences vs ${comparedTo}.`, ""];
  }
  return [
    `### Possible flakiness: ${correctness.length} link(s) with a different outcome vs ${comparedTo}`,
    "",
    "Live network checks, not necessarily caused by this change.",
    "",
    "| Link | Expected | Actual |",
    "| --- | --- | --- |",
    ...correctness.map((entry) => `| ${entry.href} | ${entry.expected} | ${entry.actual} |`),
    "",
  ];
};

/** Markdown benchmark report: a comparison table (with `--base`) or a solo summary, plus the correctness check */
export const renderReport = (input: ReportInput): string => {
  const lines = [
    COMMENT_MARKER,
    ...(input.base ? renderComparison({ ...input, base: input.base }) : renderSolo(input)),
    ...renderCorrectness(
      input.correctness,
      input.base ? "base" : `the corpus' recorded outcome (generated ${input.corpus.generatedAt})`,
    ),
    ...renderComposition(input.corpus),
    `<sub>Corpus generated ${input.corpus.generatedAt} at ${input.corpus.gitSha.slice(0, 7)}.</sub>`,
    "",
  ];
  return `${lines.join("\n")}\n`;
};
