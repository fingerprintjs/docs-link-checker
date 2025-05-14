import { checkGitHubPullRequestLink } from "./gh_pr";
import { expect, describe, it } from "vitest";

describe("checkGitHubPullRequestLink", () => {
  it("should return success for an existing pull request", async () => {
    const url = new URL("https://github.com/fingerprintjs/fingerprintjs/pull/1094");
    const result = await checkGitHubPullRequestLink(url, "fingerprintjs", "fingerprintjs", [
      "pull",
      "1094",
    ]);

    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should return error for a non-existent pull request", async () => {
    const url = new URL("https://github.com/fingerprintjs/fingerprintjs/pull/999999");
    const result = await checkGitHubPullRequestLink(url, "fingerprintjs", "fingerprintjs", [
      "pull",
      "999999",
    ]);

    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "Pull request #999999 not found in repository fingerprintjs/fingerprintjs",
    });
  });

  it("should return error for invalid pull request number", async () => {
    const url = new URL("https://github.com/fingerprintjs/fingerprintjs/pull/invalid");
    const result = await checkGitHubPullRequestLink(url, "fingerprintjs", "fingerprintjs", [
      "pull",
      "invalid",
    ]);

    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "Invalid pull request number",
    });
  });

  it("should return error for non-existent repository", async () => {
    const url = new URL("https://github.com/fingerprintjs/nonexistent-repo/pull/1");
    const result = await checkGitHubPullRequestLink(url, "fingerprintjs", "nonexistent-repo", [
      "pull",
      "1",
    ]);

    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "Pull request #1 not found in repository fingerprintjs/nonexistent-repo",
    });
  });
});
