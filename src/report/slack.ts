/**
 * Slack message about the links to notify about (new or due for a reminder, see `compare.ts`) in the saved JSON
 * reports of a run. The scheduled workflow posts it, see `scripts/slack_message.ts`.
 * Slack formatting: https://docs.slack.dev/messaging/formatting-message-text
 */
import { z } from "zod";
import type { FailedLink } from "../types";
import type { NotifyReason } from "./compare";
import { displayUrl, findSiteOrigin, groupByTarget, isHttpUrl, problemLabel } from "./format";

/** Lines of links per report, the rest is counted (`+3 more in the report`) */
const MAX_LINES_PER_REPORT = 10;

const ICONS: Record<NotifyReason, string> = { new: "🆕", reminder: "⏰" };

const resultSchema = z.object({
  ok: z.literal(false),
  error: z.enum(["broken link", "hash not found", "unexpected error", "could not check"]),
  status: z.number().optional(),
  errorDetail: z.string().optional(),
  redirectedTo: z.string().optional(),
}) satisfies z.ZodType<FailedLink["result"]>;

const linkSchema = z.object({
  page: z.string(),
  href: z.string(),
  text: z.string(),
  line: z.number().optional(),
  result: resultSchema,
  brokenSince: z.iso.datetime(),
  notify: z.enum(["new", "reminder"]).optional(),
});

const reportSchema = z
  .object({
    siteName: z.string(),
    brokenLinks: z.array(linkSchema),
    hashNotFound: z.array(linkSchema),
    networkErrors: z.array(linkSchema),
  })
  .transform(({ siteName, brokenLinks, hashNotFound, networkErrors }) => ({
    siteName,
    linksToFix: [...brokenLinks, ...hashNotFound, ...networkErrors],
  }));

export type SlackReport = z.infer<typeof reportSchema>;
type LinkToFix = SlackReport["linksToFix"][number];

/** Reads what the message needs from a saved JSON report */
export const parseSlackReport = (data: unknown): SlackReport => reportSchema.parse(data);

// `&`, `<` and `>` are control characters in Slack text, `<!channel>` would mention everyone
const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** `<url|label>`, a `|` in the URL would end the URL early */
const slackLink = (url: string, label?: string) =>
  `<${escape(url).replace(/\|/g, "%7C")}${label === undefined ? "" : `|${escape(label)}`}>`;

const code = (text: string) => `\`${escape(text.replace(/`/g, "'"))}\``;

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

type NotifyGroup = { reason: NotifyReason; link: LinkToFix; pages: LinkToFix[] };

/** One group per link target and reason, new links first */
const groupLinksToNotify = (links: LinkToFix[]): NotifyGroup[] =>
  (["new", "reminder"] as const).flatMap((reason) =>
    groupByTarget(links.filter((link) => link.notify === reason)).map(({ link, pages }) => ({
      reason,
      link,
      pages,
    })),
  );

const linkLines = ({ reason, link, pages }: NotifyGroup, siteOrigin?: string): string => {
  const target = isHttpUrl(link.href) ? slackLink(link.href) : code(link.href);
  const since = reason === "reminder" ? `, broken since ${formatDate(link.brokenSince)}` : "";
  const page = isHttpUrl(link.page)
    ? slackLink(link.page, displayUrl(link.page, siteOrigin))
    : code(link.page);
  const more =
    pages.length > 1
      ? ` and ${pages.length - 1} more ${pages.length === 2 ? "page" : "pages"}`
      : "";
  return `• ${ICONS[reason]} ${code(problemLabel(link))} ${target}${since}\n    on ${page}${more}`;
};

type ReportWithUrl = { report: SlackReport; url: string };

/**
 * The message, or `undefined` when no report has a link to notify about.
 * Reports with links to notify about come first, with their links, the others get one line.
 */
export const renderSlackMessage = (
  reports: ReportWithUrl[],
  { indexUrl }: { indexUrl: string },
): string | undefined => {
  const sections = reports.map(({ report, url }) => ({
    title: `*${escape(report.siteName)}*`,
    reportLink: slackLink(url, "report"),
    groups: groupLinksToNotify(report.linksToFix),
    report,
  }));
  const total = sections.reduce((sum, { groups }) => sum + groups.length, 0);
  if (total === 0) {
    return undefined;
  }

  const busy = sections
    .filter(({ groups }) => groups.length > 0)
    .map(({ title, reportLink, groups, report }) => {
      const newCount = groups.filter(({ reason }) => reason === "new").length;
      const reminders = groups.length - newCount;
      const counts = [
        ...(newCount > 0 ? [`${newCount} new`] : []),
        ...(reminders > 0 ? [plural(reminders, "reminder")] : []),
      ].join(", ");
      const siteOrigin = findSiteOrigin(report.linksToFix);
      const more = groups.length - MAX_LINES_PER_REPORT;
      return [
        `${title} · ${counts} · ${reportLink}`,
        ...groups.slice(0, MAX_LINES_PER_REPORT).map((group) => linkLines(group, siteOrigin)),
        ...(more > 0 ? [`+${more} more in the report`] : []),
      ].join("\n");
    });
  const quiet = sections
    .filter(({ groups }) => groups.length === 0)
    .map(({ title, reportLink, report }) => {
      const stillBroken = groupByTarget(report.linksToFix).length;
      return `${title} · nothing new${stillBroken > 0 ? `, ${stillBroken} still broken` : ""} · ${reportLink}`;
    });

  return [
    `*Link check: ${plural(total, "broken link")} to look at*`,
    ...busy,
    ...(quiet.length > 0 ? [quiet.join("\n")] : []),
    `_Reminders repeat every 7 days while a link stays broken. ${slackLink(indexUrl, "All reports")}_`,
  ].join("\n\n");
};
