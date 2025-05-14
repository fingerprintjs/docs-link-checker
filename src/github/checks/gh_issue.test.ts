import { checkGitHubIssueLink } from "./gh_issue";
import { describe, it, expect } from "vitest";

describe("checkGitHubIssueLink", () => {
  it("should return success for an existing issue", async () => {
    // Using a known existing issue from a public repository
    const result = await checkGitHubIssueLink("fingerprintjs", "fingerprintjs", ["issues", "1"]);

    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should return success for new issue path", async () => {
    const result = await checkGitHubIssueLink("fingerprintjs", "fingerprintjs", ["issues", "new"]);

    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should return error for a non-existent issue", async () => {
    // Using a very high issue number that likely doesn't exist
    const result = await checkGitHubIssueLink("fingerprintjs", "fingerprintjs", [
      "issues",
      "999999",
    ]);

    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "Issue #999999 not found in repository fingerprintjs/fingerprintjs",
    });
  });

  it("should return error for invalid issue number format", async () => {
    const result = await checkGitHubIssueLink("fingerprintjs", "fingerprintjs", [
      "issues",
      "invalid",
    ]);

    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "Issue #NaN not found in repository fingerprintjs/fingerprintjs",
    });
  });

  it("should return error for non-existent repository", async () => {
    const result = await checkGitHubIssueLink("fingerprintjs", "nonexistent-repo", ["issues", "1"]);

    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "Issue #1 not found in repository fingerprintjs/nonexistent-repo",
    });
  });
});
