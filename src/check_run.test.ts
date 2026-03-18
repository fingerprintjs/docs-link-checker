import { describe, expect, it } from "vitest";
import { getLinkCheckExitCode, shouldFailOnLinkIssues } from "./check_run";

describe("shouldFailOnLinkIssues()", () => {
  it("fails by default", () => {
    expect(shouldFailOnLinkIssues({})).toBe(true);
  });

  it("does not fail when explicitly disabled", () => {
    expect(shouldFailOnLinkIssues({ FAIL_ON_LINK_ISSUES: "false" })).toBe(false);
  });
});

describe("getLinkCheckExitCode()", () => {
  it("returns success when the report has no issues", () => {
    expect(getLinkCheckExitCode({ summary: { totalLinksToFix: 0 } })).toBe(0);
  });

  it("returns failure when issues exist and failure is enabled", () => {
    expect(getLinkCheckExitCode({ summary: { totalLinksToFix: 3 } }, {})).toBe(1);
  });

  it("returns success when issues exist but failure is disabled", () => {
    expect(
      getLinkCheckExitCode(
        { summary: { totalLinksToFix: 3 } },
        { FAIL_ON_LINK_ISSUES: "false" }
      )
    ).toBe(0);
  });
});
