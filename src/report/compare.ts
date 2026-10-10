/**
 * Trend against a previous JSON report: how many links to fix are new and how many were fixed.
 * A link is identified by page, href and problem (`error`), so a different status code or message of the same
 * problem is not a change.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { LinkWithResult } from "../types";
import { getErrorMessage } from "../utils/errors";

export type ReportDiff = { new: number; fixed: number };

/** What is needed from a previous report: its links to fix */
export type PreviousReport = { linksToFix: Array<{ page: string; href: string; error: string }> };

const linkSchema = z.object({
  page: z.string(),
  href: z.string(),
  result: z.object({ error: z.string() }),
});

const previousReportSchema = z.object({
  brokenLinks: z.array(linkSchema),
  hashNotFound: z.array(linkSchema),
  networkErrors: z.array(linkSchema),
});

/** One line: the first invalid field for a bad report (a zod message is multi-line JSON), else the first line */
const describeError = (error: unknown): string => {
  const issue = error instanceof z.ZodError ? error.issues[0] : undefined;
  return issue
    ? `${issue.path.join(".") || "report"}: ${issue.message}`
    : (getErrorMessage(error).split("\n")[0] ?? "");
};

/**
 * Reads the links to fix of a previous report (the JSON file this tool saves). A missing or unusable file is not
 * an error (the first run has no previous report): a one-line notice is logged and there is no comparison.
 */
export const loadPreviousReport = (path: string): PreviousReport | undefined => {
  try {
    const report = previousReportSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    return {
      linksToFix: [...report.brokenLinks, ...report.hashNotFound, ...report.networkErrors].map(
        ({ page, href, result }) => ({ page, href, error: result.error }),
      ),
    };
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    console.log(
      missing
        ? `No previous report at ${path}, skipping the comparison.`
        : `Could not read the previous report ${path} (${describeError(error)}), skipping the comparison.`,
    );
    return undefined;
  }
};

const keyOf = ({ page, href, error }: { page: string; href: string; error: string }) =>
  JSON.stringify([page, href, error]);

/** Links to fix that are not in the previous report (`new`) and previous ones that are gone (`fixed`) */
export const diffLinksToFix = (previous: PreviousReport, current: LinkWithResult[]): ReportDiff => {
  const before = new Set(previous.linksToFix.map(keyOf));
  const after = new Set(
    current.flatMap(({ page, href, result }) =>
      result.ok ? [] : [keyOf({ page, href, error: result.error })],
    ),
  );
  return {
    new: [...after].filter((key) => !before.has(key)).length,
    fixed: [...before].filter((key) => !after.has(key)).length,
  };
};
