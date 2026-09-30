import { describe, expect, it } from "vitest";
import { checkGitHubDiscussionLink } from "./gh_discussion";

describe("checkGitHubDiscussionLink", () => {
  it("should return success for an existing discussion", async () => {
    // Using a known existing discussion from a public repository
    const result = await checkGitHubDiscussionLink("fingerprintjs", "fingerprintjs", 916);

    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should return broken link for a non-existent discussion", async () => {
    // Using a very high discussion number that likely doesn't exist
    const result = await checkGitHubDiscussionLink("fingerprintjs", "fingerprintjs", 999999);

    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "Discussion #999999 not found in repository fingerprintjs/fingerprintjs",
    });
  });

  it("should return error for a non-existent repository", async () => {
    const result = await checkGitHubDiscussionLink("fingerprintjs", "nonexistent-repo", 1);

    expect(result).toMatchObject({
      ok: false,
      error: "unexpected error",
      status: 500,
    });
  });
});
