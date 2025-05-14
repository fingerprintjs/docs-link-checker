import { expect, describe, it } from "vitest";
import { checkIfRepositoryExists } from "./gh_repo";
import { checkGitHubDiscussionLink } from "./gh_discussion";

describe("checkIfRepositoryExists", () => {
  it("should return success for an existing repository", async () => {
    const result = await checkIfRepositoryExists("fingerprintjs", "fingerprintjs");

    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should return error for a non-existent repository", async () => {
    const result = await checkIfRepositoryExists("fingerprintjs", "nonexistent-repo");

    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "Repository fingerprintjs/nonexistent-repo not found",
    });
  });
});
