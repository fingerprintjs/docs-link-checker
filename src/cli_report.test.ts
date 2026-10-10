import { describe, expect, it } from "vitest";
import { formatFileProblems, formatTargetGroups, formatVerdict } from "./cli_report";
import { getJSONReport } from "./report/report";
import type { LinkWithResult } from "./types";

const plain = (_format: unknown, text: string) => text;
const run = { generatedAt: new Date("2026-01-02T03:04:05Z"), durationMs: 10 };

const link = (extra: Partial<LinkWithResult>): LinkWithResult => ({
  href: "https://example.com/gone",
  page: "https://example.com/page",
  text: "text",
  result: { ok: false, error: "broken link", status: 404, errorDetail: "Not Found" },
  ...extra,
});

describe("CLI report", () => {
  it("prints remote text on one line without control characters", () => {
    const report = getJSONReport({
      ...run,
      siteName: "example.com",
      links: [link({ text: "a\nFAKE ✓ OK\u001B[2K\u009B1;31mred\r\tb" })],
    });
    const output = formatTargetGroups(report, plain).join("\n");
    expect(output).toContain('↳ example.com/page  "a FAKE ✓ OKred b"');
    expect(output.split("\n")).toHaveLength(3);
  });

  it("shows the reason of a target in grouped output", () => {
    const report = getJSONReport({ ...run, siteName: "example.com", links: [link({})] });
    expect(formatTargetGroups(report, plain)[0]).toContain("Not Found");
    expect(formatFileProblems(report, plain)[0]).toContain("Not Found");
  });

  it("counts a link that failed without status as a network error in the verdict", () => {
    const report = getJSONReport({
      ...run,
      siteName: "example.com",
      links: [link({ result: { ok: false, error: "broken link" } })],
    });
    const verdict = formatVerdict(report, plain, {
      htmlPath: "r.html",
      baselineHint: false,
      notFailing: false,
    });
    expect(verdict[0]).toContain("(1 network errors)");
  });
});
