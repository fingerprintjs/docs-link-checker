import { describe, it, expect } from "vitest";
import { checkGitHubIssueLink } from "./checkGithubLink";
import { checkGitHubBlobLink } from "./checkGithubLink";
import { checkGitHubRateLimit } from "./getGithubLinks";
import { checkLinkWithGithubApi } from "./checkGithubLink";
import { checkGitHubBranchLink } from "./checkGithubLink";
import { checkIfRepositoryExists } from "./checkGithubLink";
import { checkGitHubDiscussionLink } from "./checkGithubLink";
import { checkGitHubReleaseLink } from "./checkGithubLink";

checkGitHubRateLimit();

describe("checkGitHubIssueLink", () => {
  it("should return success for an existing issue", async () => {
    // Using a known existing issue from a public repository
    const result = await checkGitHubIssueLink("fingerprintjs", "fingerprintjs", 1);

    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should return error for a non-existent issue", async () => {
    // Using a very high issue number that likely doesn't exist
    const result = await checkGitHubIssueLink("fingerprintjs", "fingerprintjs", 999999);

    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "Issue #999999 not found in repository fingerprintjs/fingerprintjs",
    });
  });
});

describe("checkGitHubBlobLink", () => {
  it("should return success for an existing file without hash", async () => {
    const url = new URL("https://github.com/fingerprintjs/fingerprintjs/blob/master/readme.md");
    const result = await checkGitHubBlobLink(url, "fingerprintjs", "fingerprintjs", ["blob", "master", "readme.md"]);

    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should return success for an existing file with valid hash", async () => {
    const url = new URL("https://github.com/fingerprintjs/fingerprintjs/blob/master/readme.md#demo");
    const result = await checkGitHubBlobLink(url, "fingerprintjs", "fingerprintjs", ["blob", "master", "readme.md"]);

    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should return error for an existing file with invalid hash", async () => {
    const url = new URL("https://github.com/fingerprintjs/fingerprintjs/blob/master/readme.md#nonexistent-heading");
    const result = await checkGitHubBlobLink(url, "fingerprintjs", "fingerprintjs", ["blob", "master", "readme.md"]);

    expect(result).toMatchObject({
      ok: false,
      error: "hash not found",
      status: 200,
      errorDetail: "No heading found matching hash: nonexistent-heading",
    });
  });

  it("should return error for a non-existent file", async () => {
    const url = new URL("https://github.com/fingerprintjs/fingerprintjs/blob/master/nonexistent.md");
    const result = await checkGitHubBlobLink(url, "fingerprintjs", "fingerprintjs", [
      "blob",
      "master",
      "nonexistent.md",
    ]);

    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "File not found in repository",
    });
  });
});

describe("checkGitHubBranchLink", () => {
  it("should return success for an existing branch without path", async () => {
    const url = new URL("https://github.com/fingerprintjs/fingerprintjs/tree/master");
    const result = await checkGitHubBranchLink(url, "fingerprintjs", "fingerprintjs", ["tree", "master"]);

    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should return success for an existing branch with valid path", async () => {
    const url = new URL("https://github.com/fingerprintjs/fingerprintjs/tree/master/src");
    const result = await checkGitHubBranchLink(url, "fingerprintjs", "fingerprintjs", ["tree", "master", "src"]);

    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should return error for an existing branch with invalid path", async () => {
    const url = new URL("https://github.com/fingerprintjs/fingerprintjs/tree/master/nonexistent/path");
    const result = await checkGitHubBranchLink(url, "fingerprintjs", "fingerprintjs", [
      "tree",
      "master",
      "nonexistent",
      "path",
    ]);

    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "Path nonexistent/path not found in branch master",
    });
  });

  it("should return error for a non-existent branch", async () => {
    const url = new URL("https://github.com/fingerprintjs/fingerprintjs/tree/nonexistent-branch");
    const result = await checkGitHubBranchLink(url, "fingerprintjs", "fingerprintjs", ["tree", "nonexistent-branch"]);

    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "Branch nonexistent-branch not found in repository fingerprintjs/fingerprintjs",
    });
  });
});

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

describe("checkLinkWithGithubApi", () => {
  it("should throw error for non-GitHub URLs", async () => {
    await expect(checkLinkWithGithubApi("https://example.com")).rejects.toThrow("Not a GitHub URL");
  });

  it("should handle GitHub issue links", async () => {
    const result = await checkLinkWithGithubApi("https://github.com/fingerprintjs/fingerprintjs/issues/1");
    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should handle non-existent GitHub issue links", async () => {
    const result = await checkLinkWithGithubApi("https://github.com/fingerprintjs/fingerprintjs/issues/999999");
    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "Issue #999999 not found in repository fingerprintjs/fingerprintjs",
    });
  });

  it("should handle GitHub blob links without hash", async () => {
    const result = await checkLinkWithGithubApi("https://github.com/fingerprintjs/fingerprintjs/blob/master/readme.md");
    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should handle GitHub blob links with valid hash", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprintjs/blob/master/readme.md#demo"
    );
    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should handle GitHub blob links with invalid hash", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprintjs/blob/master/readme.md#nonexistent-heading"
    );
    expect(result).toMatchObject({
      ok: false,
      error: "hash not found",
      status: 200,
      errorDetail: "No heading found matching hash: nonexistent-heading",
    });
  });

  it("should handle non-existent GitHub blob links", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprintjs/blob/master/nonexistent.md"
    );
    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "File not found in repository",
    });
  });

  it("should return error for unexpected link types", async () => {
    const result = await checkLinkWithGithubApi("https://github.com/fingerprintjs/fingerprintjs/unknown/path");
    expect(result).toMatchObject({
      ok: false,
      error: "unexpected error",
      status: 400,
      errorDetail: "Unknown link type: unknown/path",
    });
  });

  it("should handle GitHub discussion links", async () => {
    const result = await checkLinkWithGithubApi("https://github.com/fingerprintjs/fingerprintjs/discussions/916");
    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should handle non-existent GitHub discussion links", async () => {
    const result = await checkLinkWithGithubApi("https://github.com/fingerprintjs/fingerprintjs/discussions/999999");
    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
    });
  });

  it("should handle GitHub branch links", async () => {
    const result = await checkLinkWithGithubApi("https://github.com/fingerprintjs/fingerprintjs/tree/master");
    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should handle non-existent GitHub branch links", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprintjs/tree/nonexistent-branch"
    );
    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
    });
  });

  it("should handle GitHub pull request links", async () => {
    const result = await checkLinkWithGithubApi("https://github.com/fingerprintjs/fingerprintjs/pull/1");
    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should handle non-existent GitHub pull request links", async () => {
    const result = await checkLinkWithGithubApi("https://github.com/fingerprintjs/fingerprintjs/pull/999999");
    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
    });
  });

  it("should handle GitHub release links", async () => {
    const result = await checkLinkWithGithubApi("https://github.com/fingerprintjs/fingerprintjs/releases/tag/v1.0.0");
    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should handle non-existent GitHub release links", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprintjs/releases/tag/nonexistent-tag"
    );
    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
    });
  });

  it("should handle folder links", async () => {
    const result = await checkLinkWithGithubApi("https://github.com/fingerprintjs/fingerprintjs/tree/master/src");
    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should handle non-existent folder links", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprintjs/tree/master/nonexistent"
    );
    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
    });
  });
});

describe.only("checkGitHubReleaseLink", () => {
  it("should return success for latest release when releases exist", async () => {
    const url = new URL("https://github.com/fingerprintjs/fingerprintjs/releases/latest");
    const result = await checkGitHubReleaseLink(url, "fingerprintjs", "fingerprintjs", ["releases", "latest"]);

    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should return error for latest release when no releases exist", async () => {
    const url = new URL("https://github.com/fingerprintjs/fingerprintjs/releases/latest");
    const result = await checkGitHubReleaseLink(url, "fingerprintjs", "nonexistent-repo", ["releases", "latest"]);

    expect(result).toMatchObject({
      ok: false,
      error: "unexpected error",
      status: 500,
    });
  });

  it("should return success for a valid release tag", async () => {
    const url = new URL("https://github.com/fingerprintjs/fingerprintjs/releases/tag/v3.0.0");
    const result = await checkGitHubReleaseLink(url, "fingerprintjs", "fingerprintjs", ["releases", "tag", "v3.0.0"]);

    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should return error for an invalid release tag", async () => {
    const url = new URL("https://github.com/fingerprintjs/fingerprintjs/releases/tag/nonexistent-tag");
    const result = await checkGitHubReleaseLink(url, "fingerprintjs", "fingerprintjs", [
      "releases",
      "tag",
      "nonexistent-tag",
    ]);

    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "Release tag nonexistent-tag not found in repository fingerprintjs/fingerprintjs",
    });
  });

  it("should return error for invalid release URL format", async () => {
    const url = new URL("https://github.com/fingerprintjs/fingerprintjs/releases/invalid");
    const result = await checkGitHubReleaseLink(url, "fingerprintjs", "fingerprintjs", ["releases", "invalid"]);

    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "Invalid release URL format",
    });
  });
});