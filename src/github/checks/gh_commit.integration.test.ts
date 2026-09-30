import { expect, describe, it } from "vitest";
import { checkGitHubCommitLink } from "./gh_commit";

describe("checkGitHubCommitLink", () => {
  it("should return success for an existing commit", async () => {
    // Using a known existing commit from a public repository
    const result = await checkGitHubCommitLink("fingerprintjs", "fingerprintjs", [
      "commit",
      "9a6c283cdeaee8905d5f085aef180c6ebbbf0e04",
    ]);

    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should return error for a non-existent commit", async () => {
    // Using a non-existent commit hash
    const result = await checkGitHubCommitLink("fingerprintjs", "fingerprintjs", [
      "commit",
      "0000000000000000000000000000000000000000",
    ]);

    expect(result).toMatchObject({
      ok: false,
      error: "unexpected error",
    });
  });

  it("should return error for a non-existent repository", async () => {
    const result = await checkGitHubCommitLink("fingerprintjs", "nonexistent-repo", [
      "commit",
      "9a6c283cdeaee8905d5f085aef180c6ebbbf0e04",
    ]);

    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "Commit not found",
    });
  });
});
