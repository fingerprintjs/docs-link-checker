import { resolve } from "node:path";
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import type { ActionsEnv } from "./config";
import { getLinksToFix, type LinkCheckReport } from "./report/report";
import type { LinkWithResult } from "./types";

/** How many links to fix are listed in the job summary table */
const SUMMARY_TABLE_LIMIT = 50;
const MAX_CELL_LENGTH = 300;

/**
 * Escapes text for a markdown table cell: pipes, line breaks, and HTML (GitHub renders some HTML in summaries).
 * Long values are shortened.
 */
const escapeTableCell = (value: string, maxLength = MAX_CELL_LENGTH): string => {
  const singleLine = value.replace(/\s*[\r\n]+\s*/g, " ").trim();
  const shortened =
    singleLine.length > maxLength ? `${singleLine.slice(0, maxLength - 1)}…` : singleLine;
  return shortened
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "\\`")
    .replace(/\[/g, "\\[")
    .replace(/]/g, "\\]");
};

const pageWithLine = (link: LinkWithResult) =>
  link.line ? `${link.page}:${link.line}` : link.page;

/** Short description of a failed result: `broken link (404): detail` */
export const describeResult = (link: LinkWithResult): string => {
  const { result } = link;
  if (result.ok) {
    return "OK";
  }
  const status = result.status ? ` (${result.status})` : "";
  const detail = result.errorDetail?.trim() ? `: ${result.errorDetail.trim()}` : "";
  return `${result.error}${status}${detail}`;
};

type SummaryOptions = {
  limit?: number;
  /** Paths of the saved reports, mentioned in the summary */
  reportPaths?: { json: string; html: string };
};

/** Markdown summary of a report for the GitHub job summary (`GITHUB_STEP_SUMMARY`) */
export const renderJobSummary = (
  report: LinkCheckReport,
  { limit = SUMMARY_TABLE_LIMIT, reportPaths }: SummaryOptions = {},
): string => {
  const { summary } = report;
  const icon = summary.totalLinksToFix > 0 ? "❌" : "✅";
  const lines = [
    `## ${icon} Link check: ${escapeTableCell(report.siteName)}`,
    "",
    "| Links checked | To fix | Broken links | Hash not found | Network errors | Could not check | Ignored |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    `| ${summary.linksChecked} | ${summary.totalLinksToFix} | ${summary.brokenLinks} | ${summary.hashNotFound} | ${summary.networkErrors} | ${summary.couldNotCheck} | ${summary.ignored} |`,
    "",
  ];

  const linksToFix = getLinksToFix(report);
  if (linksToFix.length > 0) {
    lines.push(
      "### Links to fix",
      "",
      "| Page | Link | Error |",
      "| --- | --- | --- |",
      ...linksToFix
        .slice(0, limit)
        .map(
          (link) =>
            `| ${escapeTableCell(pageWithLine(link))} | ${escapeTableCell(link.href)} | ${escapeTableCell(describeResult(link))} |`,
        ),
      "",
    );
    if (linksToFix.length > limit) {
      lines.push(
        `Showing the first ${limit} of ${linksToFix.length} links to fix, see the full report for the rest.`,
        "",
      );
    }
  }
  if (reportPaths) {
    lines.push(
      `Full report: \`${reportPaths.html.replace(/`/g, "")}\` (JSON: \`${reportPaths.json.replace(/`/g, "")}\`).`,
      "",
    );
  }
  return `${lines.join("\n")}\n`;
};

/**
 * Appends the job summary to `summaryFile` (`ActionsEnv.stepSummary`).
 * @returns `true` if the summary was written
 */
export const writeJobSummary = Effect.fn("writeJobSummary")(function* (
  report: LinkCheckReport,
  options: SummaryOptions,
  summaryFile: string | undefined,
) {
  if (!summaryFile) {
    return false;
  }
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(summaryFile, renderJobSummary(report, options), { flag: "a" });
  return true;
});

// https://github.com/actions/toolkit/blob/main/packages/core/src/command.ts
const escapeCommandData = (value: string) =>
  value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeCommandProperty = (value: string) =>
  escapeCommandData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");

type AnnotationLevel = "error" | "warning";

/** A workflow command annotation: `::error file=docs/a.md,line=3,title=Broken link::message` */
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

const TITLES: Record<string, string> = {
  "broken link": "Broken link",
  "hash not found": "Anchor not found",
  "unexpected error": "Link check error",
  "could not check": "Could not check link",
};

/**
 * Annotations for local files: errors for links to fix, warnings for links that could not be checked.
 * Ignored links are not annotated.
 */
export const getFileAnnotations = (report: LinkCheckReport): string[] => {
  const annotate = (level: AnnotationLevel) => (link: LinkWithResult) =>
    formatAnnotation(
      level,
      {
        file: link.page,
        line: link.line,
        title: link.result.ok ? undefined : TITLES[link.result.error],
      },
      `${link.href}: ${describeResult(link)}`,
    );
  return [
    ...getLinksToFix(report).map(annotate("error")),
    ...report.couldNotCheck.map(annotate("warning")),
  ];
};

/**
 * Writes `name=value` outputs to `outputFile` (`ActionsEnv.output`), if set.
 * A multi-line value is a programmer error (the format of the file would break), so it dies.
 * @returns `true` if the outputs were written
 */
export const writeGithubOutputs = Effect.fn("writeGithubOutputs")(function* (
  outputs: Record<string, string | number>,
  outputFile: string | undefined,
) {
  if (!outputFile) {
    return false;
  }
  const entries = Object.entries(outputs).map(([name, value]) => [name, String(value)] as const);
  for (const [name, value] of entries) {
    if (/[\r\n]/.test(value)) {
      return yield* Effect.dieMessage(`Output ${name} must be a single line`);
    }
  }
  const fs = yield* FileSystem.FileSystem;
  const text = entries.map(([name, value]) => `${name}=${value}\n`).join("");
  yield* fs.writeFileString(outputFile, text, { flag: "a" });
  return true;
});

const REPOSITORY_NAME = /^[\w.-]+\/[\w.-]+$/;
const COMMIT_SHA = /^[\da-f]{40}(?:[\da-f]{24})?$/;

/**
 * Base URL of the checked commit's files on GitHub (`https://github.com/owner/repo/blob/<sha>/`), used to link
 * local files in the HTML report. Only when running in GitHub Actions from the repository root
 * (`cwd` is `GITHUB_WORKSPACE`), so file paths are relative to the repository. All values are validated.
 */
export const getGithubBlobBaseUrl = (env: ActionsEnv, cwd: string): string | undefined => {
  const { actions, serverUrl, repository, sha, workspace } = env;
  if (actions !== "true" || !workspace || resolve(cwd) !== resolve(workspace)) {
    return undefined;
  }
  if (!repository || !REPOSITORY_NAME.test(repository)) return undefined;
  if (!sha || !COMMIT_SHA.test(sha)) return undefined;
  let server: URL;
  try {
    server = new URL(serverUrl || "https://github.com");
  } catch {
    return undefined;
  }
  if (server.protocol !== "https:" || server.search || server.hash || server.pathname !== "/") {
    return undefined;
  }
  return `${server.origin}/${repository}/blob/${sha}/`;
};
