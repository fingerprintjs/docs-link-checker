import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LinkWithResult } from "../types";
import { loadPreviousReport } from "./compare";
import { getJSONReport } from "./report";

const PAGE = "https://example.com/";
const brokenLink = (href: string): LinkWithResult => ({
  page: PAGE,
  href,
  text: "",
  result: { ok: false, error: "broken link" },
});

const SINCE = new Date("2026-01-01T03:00:00Z");
const day = (days: number) => new Date(SINCE.getTime() + days * 24 * 60 * 60 * 1000);

/** Reminders of a link broken since `SINCE`, checked at `previousAt` and again at `now` */
const remindersBetween = (previousAt: Date, now: Date) =>
  getJSONReport({
    links: [brokenLink("https://a/")],
    siteName: "site",
    generatedAt: now,
    durationMs: 0,
    previous: {
      generatedAt: previousAt,
      linksToFix: [{ page: PAGE, href: "https://a/", error: "broken link", brokenSince: SINCE }],
    },
  }).diff?.reminders;

describe("reminders for links still broken", () => {
  it.each([
    { previousAt: day(6), now: day(7), reminders: 1, case: "first week passed" },
    { previousAt: day(13), now: day(14), reminders: 1, case: "second week passed" },
    { previousAt: day(7), now: day(8), reminders: 0, case: "reminded by the previous run" },
    { previousAt: day(1), now: day(2), reminders: 0, case: "less than a week" },
    { previousAt: day(6), now: day(15), reminders: 1, case: "two weeks passed between runs" },
  ])("$case: $reminders", ({ previousAt, now, reminders }) => {
    expect(remindersBetween(previousAt, now)).toBe(reminders);
  });

  it("counts a new link as new, not as a reminder", () => {
    const report = getJSONReport({
      links: [brokenLink("https://new/")],
      siteName: "site",
      generatedAt: day(7),
      durationMs: 0,
      previous: { generatedAt: day(6), linksToFix: [] },
    });
    expect(report.diff).toEqual({ new: 1, fixed: 0, reminders: 0 });
  });

  it("marks the links to notify about and counts them", () => {
    const report = getJSONReport({
      links: [
        brokenLink("https://new/"),
        brokenLink("https://week/"),
        brokenLink("https://quiet/"),
      ],
      siteName: "site",
      generatedAt: day(7),
      durationMs: 0,
      previous: {
        generatedAt: day(6),
        linksToFix: [
          { page: PAGE, href: "https://week/", error: "broken link", brokenSince: SINCE },
          { page: PAGE, href: "https://quiet/", error: "broken link", brokenSince: day(3) },
        ],
      },
    });
    expect(report.brokenLinks.map(({ href, notify }) => [href, notify])).toEqual([
      ["https://new/", "new"],
      ["https://week/", "reminder"],
      ["https://quiet/", undefined],
    ]);
    expect(report.summary.linksToNotify).toBe(2);
  });

  it("notifies about every link to fix without a previous report", () => {
    const report = getJSONReport({
      links: [brokenLink("https://a/")],
      siteName: "site",
      generatedAt: day(7),
      durationMs: 0,
    });
    expect(report.brokenLinks[0]?.notify).toBe("new");
    expect(report.summary.linksToNotify).toBe(1);
  });
});

describe("loadPreviousReport()", () => {
  const saveJson = (data: unknown): string => {
    const path = join(mkdtempSync(join(tmpdir(), "compare-")), "previous.json");
    writeFileSync(path, JSON.stringify(data));
    return path;
  };

  it("keeps when a link first broke across reports", () => {
    const first = getJSONReport({
      links: [brokenLink("https://a/")],
      siteName: "site",
      generatedAt: SINCE,
      durationMs: 0,
    });
    const second = getJSONReport({
      links: [brokenLink("https://a/")],
      siteName: "site",
      generatedAt: day(3),
      durationMs: 0,
      previous: loadPreviousReport(saveJson(first)),
    });
    expect(second.brokenLinks[0]?.brokenSince).toBe(SINCE.toISOString());
  });

  it("dates links of a report without brokenSince by the report time", () => {
    const withoutBrokenSince = {
      generatedAt: SINCE.toISOString(),
      brokenLinks: [brokenLink("https://a/")],
      hashNotFound: [],
      networkErrors: [],
    };
    expect(loadPreviousReport(saveJson(withoutBrokenSince))?.linksToFix).toEqual([
      { page: PAGE, href: "https://a/", error: "broken link", brokenSince: SINCE },
    ]);
  });
});
