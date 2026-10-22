/**
 * Trend against a previous JSON report: which links to fix are new, fixed, or due for a reminder, and since when
 * each link is broken.
 * A link is identified by page, href and problem (`error`), so a different status code or message of the same
 * problem is not a change.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { FailedLink } from "../types";
import { getErrorMessage } from "../utils/errors";

/**
 * A link still broken is due for a reminder each time another interval passed since it broke, so a notification
 * about it repeats weekly instead of after every daily run.
 */
const REMINDER_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export type ReportDiff = { new: number; fixed: number };

type PreviousLink = { page: string; href: string; error: string; brokenSince: Date };

/** What is needed from a previous report: when it was generated and its links to fix */
export type PreviousReport = { generatedAt: Date; linksToFix: PreviousLink[] };

const isoDate = z.iso.datetime().transform((value) => new Date(value));

const linkSchema = z.object({
  page: z.string(),
  href: z.string(),
  result: z.object({ error: z.string() }),
  // Missing in reports from versions without reminders
  brokenSince: isoDate.optional(),
});

const previousReportSchema = z.object({
  generatedAt: isoDate,
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
      generatedAt: report.generatedAt,
      linksToFix: [...report.brokenLinks, ...report.hashNotFound, ...report.networkErrors].map(
        ({ page, href, result, brokenSince }) => ({
          page,
          href,
          error: result.error,
          brokenSince: brokenSince ?? report.generatedAt,
        }),
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

const currentKey = ({ page, href, result }: FailedLink) =>
  keyOf({ page, href, error: result.error });

/** Why a link to fix is worth a notification: it broke since the previous report, or is due for a reminder */
export type NotifyReason = "new" | "reminder";

/** Reminder intervals passed between `since` and `time` */
const intervalsPassed = (since: Date, time: Date) =>
  Math.floor((time.getTime() - since.getTime()) / REMINDER_INTERVAL_MS);

/**
 * When each link to fix broke (its date in the previous report, else `now`) and whether it is worth a notification.
 * A link is reminded once even when several intervals passed between the two reports (missed runs).
 */
export const getLinkHistory = (previous: PreviousReport | undefined, now: Date) => {
  const since = new Map(previous?.linksToFix.map((link) => [keyOf(link), link.brokenSince]));
  return (link: FailedLink): { brokenSince: Date; notify?: NotifyReason } => {
    const brokenSince = since.get(currentKey(link));
    if (!previous || !brokenSince) {
      return { brokenSince: now, notify: "new" };
    }
    return intervalsPassed(brokenSince, now) > intervalsPassed(brokenSince, previous.generatedAt)
      ? { brokenSince, notify: "reminder" }
      : { brokenSince };
  };
};

/** Links to fix that are not in the previous report (`new`) and previous ones that are gone (`fixed`) */
export const diffLinksToFix = (previous: PreviousReport, current: FailedLink[]): ReportDiff => {
  const before = new Set(previous.linksToFix.map(keyOf));
  const after = new Set(current.map(currentKey));
  return {
    new: [...after].filter((key) => !before.has(key)).length,
    fixed: [...before].filter((key) => !after.has(key)).length,
  };
};
