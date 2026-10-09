import { stripVTControlCharacters } from "node:util";
import {
  countByKind,
  displayUrl,
  formatLocation,
  groupByTarget,
  type IgnoredLink,
  problemLabel,
  shortReason,
} from "./report/format";
import { getLinksToFix, type LinkCheckReport } from "./report/report";
/**
 * Terminal view of a finished check: the links to fix and the verdict. Uses the shared vocabulary of
 * `src/report/format.ts`, so labels and reasons match the HTML report and the job summary.
 * - `files`: one row per problem, `file:line` first so terminals and editors make it clickable.
 * - other commands: grouped by target with the pages under it, fixing the target once fixes every page.
 */
import { formatCount, formatDuration, type Paint, plural } from "./terminal";
import type { LinkWithResult } from "./types";
import { compareStrings } from "./utils";

/** Pages listed under a target, the report has the rest */
const MAX_PAGES_PER_TARGET = 5;
const MAX_TEXT_LENGTH = 60;

/** Remote text (link text, URLs, reasons) on one line, without control characters that could redraw the terminal */
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;
const safe = (text: string): string =>
  stripVTControlCharacters(text).replace(/\s+/g, " ").replace(CONTROL_CHARS, "").trim();

const pad = (text: string, width: number) => text.padEnd(width);

const colorOf = (label: string) =>
  label === "Anchor not found" || label === "Line out of range" ? "yellow" : "red";

/** The href with its `#hash` highlighted */
const paintHref = (paint: Paint, rawHref: string) => {
  const href = safe(rawHref);
  const hashStart = href.indexOf("#");
  return hashStart < 0 ? href : href.slice(0, hashStart) + paint("yellow", href.slice(hashStart));
};

/** Dim `reason · redirects to X`, empty if there is neither */
const paintNote = (paint: Paint, link: IgnoredLink, reason = "") => {
  const { redirectedTo } = link.result;
  const parts = [
    safe(reason),
    redirectedTo && `redirects to ${safe(displayUrl(redirectedTo))}`,
  ].filter(Boolean);
  return parts.length > 0 ? paint("dim", parts.join(" · ")) : "";
};

/** `files` command: one row per link to fix, a blank line between files */
export const formatFileProblems = (report: LinkCheckReport, paint: Paint): string[] => {
  const links = getLinksToFix(report);
  const labelWidth = Math.max(0, ...links.map((link) => problemLabel(link).length));
  const files = new Map<string, LinkWithResult[]>();
  for (const link of links) {
    const group = files.get(link.page);
    if (group) {
      group.push(link);
    } else {
      files.set(link.page, [link]);
    }
  }
  return [...files.entries()]
    .toSorted(([a], [b]) => compareStrings(a, b))
    .flatMap(([, fileLinks]) => {
      const locationWidth = Math.max(...fileLinks.map((link) => safe(formatLocation(link)).length));
      const rows = fileLinks
        .toSorted((a, b) => (a.line ?? 0) - (b.line ?? 0))
        .map((link) => {
          const label = problemLabel(link);
          return [
            paint("dim", pad(safe(formatLocation(link)), locationWidth)),
            paint(colorOf(label), pad(label, labelWidth)),
            paintHref(paint, displayUrl(link.href)),
            paintNote(paint, link, shortReason(link)),
          ]
            .filter(Boolean)
            .join("  ");
        });
      return rows.concat("");
    });
};

/** `site` and `github-org` commands: links to fix grouped by target, pages (without the site origin) below */
export const formatTargetGroups = (
  report: LinkCheckReport,
  paint: Paint,
  siteOrigin?: string,
): string[] => {
  const groups = groupByTarget(getLinksToFix(report));
  const labelWidth = Math.max(0, ...groups.map(({ link }) => problemLabel(link).length));
  return [
    ...groups.flatMap(({ link, pages }) => {
      const label = problemLabel(link);
      const header = [
        paint(colorOf(label), pad(label, labelWidth)),
        paintHref(paint, displayUrl(link.href, siteOrigin)),
        paint("dim", `on ${plural(pages.length, "page")}`),
        paintNote(paint, link, shortReason(link)),
      ]
        .filter(Boolean)
        .join("  ");
      const shown = pages.slice(0, MAX_PAGES_PER_TARGET).map((page) => {
        const pageText = safe(page.text);
        const text =
          pageText.length > MAX_TEXT_LENGTH
            ? `${pageText.slice(0, MAX_TEXT_LENGTH - 1)}…`
            : pageText;
        const quoted = text ? `  "${text}"` : "";
        return paint(
          "dim",
          `${" ".repeat(labelWidth + 2)}↳ ${safe(displayUrl(page.page, siteOrigin))}${quoted}`,
        );
      });
      const hidden = pages.length - shown.length;
      return [
        header,
        ...shown,
        ...(hidden > 0
          ? [paint("dim", `${" ".repeat(labelWidth + 2)}↳ … ${hidden} more pages`)]
          : []),
      ];
    }),
    ...(groups.length > 0 ? [""] : []),
  ];
};

type VerdictOptions = {
  /** Path of the HTML report, as shown to the user */
  htmlPath: string;
  /** Hint how to accept the failures, only useful when they fail the run and are not added already */
  baselineHint: boolean;
  /** Links to fix do not fail the run (`--no-fail-on-broken`) */
  notFailing: boolean;
};

/** Verdict, counts, trend, report path and next step */
export const formatVerdict = (
  report: LinkCheckReport,
  paint: Paint,
  { htmlPath, baselineHint, notFailing }: VerdictOptions,
): string[] => {
  const { summary, diff } = report;
  const toFix = summary.totalLinksToFix;
  const byKind = countByKind(getLinksToFix(report));
  const parts = [
    byKind.broken > 0 && `${byKind.broken} broken`,
    byKind.anchor > 0 && `${byKind.anchor} missing ${byKind.anchor === 1 ? "anchor" : "anchors"}`,
    byKind.network > 0 && `${byKind.network} network errors`,
  ].filter(Boolean);
  const headline =
    toFix > 0
      ? `${paint(["red", "bold"], `✗ ${plural(toFix, "link")} to fix`)} ${paint("dim", `(${parts.join(", ")})`)}`
      : paint(["green", "bold"], "✓ No links to fix");
  const counts = [
    `${formatCount(summary.linksChecked)} checked`,
    `${formatCount(summary.ignored)} ignored by baseline`,
    `${formatCount(summary.couldNotCheck)} could not check`,
    formatDuration(report.durationMs),
  ].join(" · ");
  return [
    headline,
    paint("dim", `  ${counts}`),
    ...(diff
      ? [
          `  ${paint(diff.new > 0 ? "red" : "dim", `+${diff.new} new`)}, ${paint(diff.fixed > 0 ? "green" : "dim", `${diff.fixed} fixed`)} ${paint("dim", "since previous report")}`,
        ]
      : []),
    `  ${paint("dim", "Report")} ${paint("cyan", htmlPath)}`,
    ...(toFix > 0 && notFailing ? [paint("dim", "  Not failing: --no-fail-on-broken")] : []),
    ...(toFix > 0 && baselineHint
      ? [`  ${paint("dim", "False positive?")} ${paint("cyan", "--update-baseline")}`]
      : []),
  ];
};
