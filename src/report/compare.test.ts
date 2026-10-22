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

/** Whether a link broken since `SINCE`, checked at `previousAt` and again at `now`, is due for a reminder */
const remindedBetween = (previousAt: Date, now: Date) =>
  getJSONReport({
    links: [brokenLink("https://a/")],
    siteName: "site",
    generatedAt: now,
    durationMs: 0,
    previous: {
      generatedAt: previousAt,
      linksToFix: [{ page: PAGE, href: "https://a/", error: "broken link", brokenSince: SINCE }],
    },
  }).brokenLinks[0]?.notify === "reminder";

describe("reminders for links still broken", () => {
  it.each([
    { previousAt: day(6), now: day(7), reminded: true, case: "first week passed" },
    { previousAt: day(13), now: day(14), reminded: true, case: "second week passed" },
    { previousAt: day(7), now: day(8), reminded: false, case: "reminded by the previous run" },
    { previousAt: day(1), now: day(2), reminded: false, case: "less than a week" },
    { previousAt: day(6), now: day(15), reminded: true, case: "two weeks passed between runs" },
  ])("$case: $reminded", ({ previousAt, now, reminded }) => {
    expect(remindedBetween(previousAt, now)).toBe(reminded);
  });

  it("marks the links to notify about", () => {
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
  });

  it("notifies about every link to fix without a previous report", () => {
    const report = getJSONReport({
      links: [brokenLink("https://a/")],
      siteName: "site",
      generatedAt: day(7),
      durationMs: 0,
    });
    expect(report.brokenLinks[0]?.notify).toBe("new");
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
      siteName: "site",
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
