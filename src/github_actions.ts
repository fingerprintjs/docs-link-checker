import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  countByKind,
  displayUrl,
  findSiteOrigin,
  formatLocation,
  groupByTarget,
  isHttpUrl,
  problemLabel,
  shortReason,
  type IgnoredLink,
  type TargetGroup,
} from "./report/format";
import { getLinksToFix, type LinkCheckReport } from "./report/report";
import type { LinkWithResult } from "./types";

/** How many targets (rows) of links to fix, and of ignored links, are listed in the job summary */
const SUMMARY_TABLE_LIMIT = 50;
/** Pages listed per row, the rest is counted (`+3 more`) */
const MAX_PAGES_PER_ROW = 2;
const MAX_CELL_LENGTH = 300;

const singleLine = (value: string, maxLength: number): string => {
  const line = value.replace(/\s*[\r\n]+\s*/g, " ").trim();
  return line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line;
};

/**
 * Escapes text for a markdown table cell: pipes, line breaks, and HTML (GitHub renders some HTML in summaries).
 * Long values are shortened.
 */
const escapeTableCell = (value: string, maxLength = MAX_CELL_LENGTH): string =>
  singleLine(value, maxLength)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "\\`")
    .replace(/\[/g, "\\[")
    .replace(/]/g, "\\]");

/**
 * Code span for a table cell: markdown and HTML are not interpreted inside it, only backticks and pipes are.
 * A backslash right before a pipe is doubled first, else `\\|` reads as an escaped backslash and a column break.
 */
const codeCell = (value: string): string =>
  `\`${singleLine(value, MAX_CELL_LENGTH)
    .replace(/`/g, "'")
    .replace(/\\(?=\|)/g, "\\\\")
    .replace(/\|/g, "\\|")}\``;

type SummaryOptions = {
  limit?: number;
};

const pageLink = (page: string, siteOrigin: string | undefined, line?: number): string => {
  if (!isHttpUrl(page)) {
    return codeCell(formatLocation({ page, line }));
  }
  const url = new URL(page).href.replace(/[()\s|]/g, encodeURIComponent);
  return `[${escapeTableCell(displayUrl(page, siteOrigin))}](${url})`;
};

const pagesCell = (group: TargetGroup<IgnoredLink>, siteOrigin: string | undefined): string => {
  const shown = group.pages
    .slice(0, MAX_PAGES_PER_ROW)
    .map((link) => pageLink(link.page, siteOrigin, link.line));
  const more = group.pages.length - MAX_PAGES_PER_ROW;
  return [...shown, ...(more > 0 ? [`+${more} more`] : [])].join("<br>");
};

/** The target (link), the reason below it and where it redirects to */
const linkCell = ({ link }: TargetGroup<IgnoredLink>, siteOrigin: string | undefined): string => {
  const notes = [
    shortReason(link),
    link.result.redirectedTo
      ? `redirects to ${displayUrl(link.result.redirectedTo, siteOrigin)}`
      : "",
  ].filter(Boolean);
  const target = codeCell(isHttpUrl(link.href) ? displayUrl(link.href, siteOrigin) : link.href);
  return notes.length > 0
    ? `${target}<br><sub>${escapeTableCell(notes.join(" · "))}</sub>`
    : target;
};

const statsLine = (report: LinkCheckReport): string => {
  const { summary, diff } = report;
  const counts = countByKind(getLinksToFix(report));
  const parts = [
    `**${counts.broken}** broken`,
    `**${counts.anchor}** missing anchors`,
    ...(counts.network > 0 ? [`**${counts.network}** network errors`] : []),
    `${summary.couldNotCheck} could not check`,
    `${summary.ignored} ignored`,
    `${summary.linksChecked.toLocaleString("en-US")} checked`,
  ];
  if (diff) {
    parts.push(`+${diff.new} new, ${diff.fixed} fixed since previous report`);
  }
  return parts.join(" · ");
};

const tableRows = <T>(items: T[], limit: number, row: (item: T) => string): string[] => {
  const rows = items.slice(0, limit).map(row);
  return items.length > limit
    ? [...rows, `| +${items.length - limit} more, see the full report | | |`]
    : rows;
};

/** Markdown summary of a report for the GitHub job summary (`GITHUB_STEP_SUMMARY`) */
export const renderJobSummary = (report: LinkCheckReport, options: SummaryOptions = {}): string => {
  const { limit = SUMMARY_TABLE_LIMIT } = options;
  const { totalLinksToFix } = report.summary;
  const siteName = escapeTableCell(report.siteName);
  const siteOrigin = findSiteOrigin([
    ...getLinksToFix(report),
    ...report.couldNotCheck,
    ...report.ignored,
  ]);
  const lines = [
    totalLinksToFix > 0
      ? `## ❌ ${siteName}: ${totalLinksToFix} ${totalLinksToFix === 1 ? "link" : "links"} to fix`
      : `## ✅ ${siteName}: no links to fix`,
    "",
    statsLine(report),
    "",
  ];

  const groups = groupByTarget(getLinksToFix(report));
  if (groups.length > 0) {
    lines.push(
      "| Problem | Link | Found on |",
      "| --- | --- | --- |",
      ...tableRows(
        groups,
        limit,
        (group) =>
          `| ${problemLabel(group.link)} | ${linkCell(group, siteOrigin)} | ${pagesCell(group, siteOrigin)} |`,
      ),
      "",
    );
  }

  const ignored = groupByTarget(report.ignored);
  if (ignored.length > 0) {
    lines.push(
      `<details><summary>${report.summary.ignored} ignored by baseline</summary>`,
      "",
      "| Link | Reason | Pages |",
      "| --- | --- | ---: |",
      ...tableRows(
        ignored,
        limit,
        ({ link, pages }) =>
          `| ${codeCell(isHttpUrl(link.href) ? displayUrl(link.href, siteOrigin) : link.href)} | ${escapeTableCell(link.ignoreReason ?? "")} | ${pages.length} |`,
      ),
      "",
      "</details>",
      "",
    );
  }

  return `${lines.join("\n")}\n`;
};

/**
 * Appends the job summary to `summaryFile` (the value of `GITHUB_STEP_SUMMARY`, pass `env.GITHUB_STEP_SUMMARY`).
 * The file is an explicit argument without a default: an `undefined` value must never fall back to the
 * real `process.env` (tests running in GitHub Actions would write to the job summary of the CI run).
 * @returns `true` if the summary was written
 */
export const writeJobSummary = (
  report: LinkCheckReport,
  options: SummaryOptions,
  summaryFile: string | undefined,
): boolean => {
  if (!summaryFile) {
    return false;
  }
  appendFileSync(summaryFile, renderJobSummary(report, options));
  return true;
};

// https://github.com/actions/toolkit/blob/main/packages/core/src/command.ts
const escapeCommandData = (value: string) =>
  value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeCommandProperty = (value: string) =>
  escapeCommandData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");

type AnnotationLevel = "error" | "warning";

/** A workflow command annotation: `::error file=docs/a.md,line=3,title=File not found::message` */
const formatAnnotation = (
  level: AnnotationLevel,
  { file, line, title }: { file: string; line?: number; title?: string },
  message: string,
): string => {
  const properties = [`file=${escapeCommandProperty(file)}`];
  if (line) properties.push(`line=${line}`);
  if (title) properties.push(`title=${escapeCommandProperty(title)}`);
  return `::${level} ${properties.join(",")}::${escapeCommandData(message)}`;
};

/**
 * Annotations for local files: errors for links to fix, warnings for links that could not be checked.
 * Ignored links are not annotated. The title is the problem, the message the link and a short reason.
 */
export const getFileAnnotations = (report: LinkCheckReport): string[] => {
  const annotate = (level: AnnotationLevel) => (link: LinkWithResult) => {
    const reason = shortReason(link);
    const message = reason.includes(link.href)
      ? reason
      : [link.href, reason].filter(Boolean).join(": ");
    return formatAnnotation(
      level,
      { file: link.page, line: link.line, title: problemLabel(link) },
      message,
    );
  };
  return [
    ...getLinksToFix(report).map(annotate("error")),
    ...report.couldNotCheck.map(annotate("warning")),
  ];
};

/**
 * Writes `name=value` outputs to `outputFile` (the value of `GITHUB_OUTPUT`, pass `env.GITHUB_OUTPUT`), if set.
 * No default for the same reason as `writeJobSummary`.
 */
export const writeGithubOutputs = (
  outputs: Record<string, string | number>,
  outputFile: string | undefined,
): boolean => {
  if (!outputFile) {
    return false;
  }
  const lines = Object.entries(outputs).map(([name, value]) => {
    const text = String(value);
    if (/[\r\n]/.test(text)) {
      throw new Error(`Output ${name} must be a single line`);
    }
    return `${name}=${text}\n`;
  });
  appendFileSync(outputFile, lines.join(""));
  return true;
};

const REPOSITORY_NAME = /^[\w.-]+\/[\w.-]+$/;
const COMMIT_SHA = /^[\da-f]{40}(?:[\da-f]{24})?$/;

/**
 * Base URL of the checked commit's files on GitHub (`https://github.com/owner/repo/blob/<sha>/`), used to link
 * local files in the HTML report. Only when running in GitHub Actions from the repository root
 * (`cwd` is `GITHUB_WORKSPACE`), so file paths are relative to the repository. All values are validated.
 */
export const getGithubBlobBaseUrl = (
  env: Record<string, string | undefined>,
  cwd: string,
): string | undefined => {
  const { GITHUB_ACTIONS, GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_WORKSPACE } =
    env;
  if (
    GITHUB_ACTIONS !== "true" ||
    !GITHUB_WORKSPACE ||
    resolve(cwd) !== resolve(GITHUB_WORKSPACE)
  ) {
    return undefined;
  }
  if (!GITHUB_REPOSITORY || !REPOSITORY_NAME.test(GITHUB_REPOSITORY)) return undefined;
  if (!GITHUB_SHA || !COMMIT_SHA.test(GITHUB_SHA)) return undefined;
  let server: URL;
  try {
    server = new URL(GITHUB_SERVER_URL || "https://github.com");
  } catch {
    return undefined;
  }
  if (server.protocol !== "https:" || server.search || server.hash || server.pathname !== "/") {
    return undefined;
  }
  return `${server.origin}/${GITHUB_REPOSITORY}/blob/${GITHUB_SHA}/`;
};
