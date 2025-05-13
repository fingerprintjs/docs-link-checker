import { describe, it, expect } from "vitest";
import { checkGitHubIssueLink } from "./checkGithubLink";
import { checkGitHubBlobLink } from "./checkGithubLink";
import { checkGitHubRateLimit } from "./getGithubLinks";
import { checkLinkWithGithubApi } from "./checkGithubLink";
import { checkGitHubBranchLink } from "./checkGithubLink";
import { checkIfRepositoryExists } from "./checkGithubLink";
import { checkGitHubDiscussionLink } from "./checkGithubLink";

checkGitHubRateLimit();

describe("checkGitHubIssueLink", () => {
  it("should return success for an existing issue", async () => {
    // Using a known existing issue from a public repository
    const result = await checkGitHubIssueLink("fingerprintjs", "fingerprintjs", 1);

    expect(result).toEqual({
      ok: true,
      status: 200,
    });
  });

  it("should return error for a non-existent issue", async () => {
    // Using a very high issue number that likely doesn't exist
    const result = await checkGitHubIssueLink("fingerprintjs", "fingerprintjs", 999999);

    expect(result).toEqual({
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

    expect(result).toEqual({
      ok: true,
      status: 200,
    });
  });

  it("should return success for an existing file with valid hash", async () => {
    const url = new URL("https://github.com/fingerprintjs/fingerprintjs/blob/master/readme.md#demo");
    const result = await checkGitHubBlobLink(url, "fingerprintjs", "fingerprintjs", ["blob", "master", "readme.md"]);

    expect(result).toEqual({
      ok: true,
      status: 200,
    });
  });

  it("should return error for an existing file with invalid hash", async () => {
    const url = new URL("https://github.com/fingerprintjs/fingerprintjs/blob/master/readme.md#nonexistent-heading");
    const result = await checkGitHubBlobLink(url, "fingerprintjs", "fingerprintjs", ["blob", "master", "readme.md"]);

    expect(result).toEqual({
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

    expect(result).toEqual({
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

    expect(result).toEqual({
      ok: true,
      status: 200,
    });
  });

  it("should return success for an existing branch with valid path", async () => {
    const url = new URL("https://github.com/fingerprintjs/fingerprintjs/tree/master/src");
    const result = await checkGitHubBranchLink(url, "fingerprintjs", "fingerprintjs", ["tree", "master", "src"]);

    expect(result).toEqual({
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

    expect(result).toEqual({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "Path nonexistent/path not found in branch master",
    });
  });

  it("should return error for a non-existent branch", async () => {
    const url = new URL("https://github.com/fingerprintjs/fingerprintjs/tree/nonexistent-branch");
    const result = await checkGitHubBranchLink(url, "fingerprintjs", "fingerprintjs", ["tree", "nonexistent-branch"]);

    expect(result).toEqual({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "Branch nonexistent-branch not found in repository fingerprintjs/fingerprintjs",
    });
  });
});

describe("checkLinkWithGithubApi", () => {
  it("should throw error for non-GitHub URLs", async () => {
    await expect(checkLinkWithGithubApi("https://example.com")).rejects.toThrow("Not a GitHub URL");
  });

  it("should handle GitHub issue links", async () => {
    const result = await checkLinkWithGithubApi("https://github.com/fingerprintjs/fingerprintjs/issues/1");
    expect(result).toEqual({
      ok: true,
      status: 200,
    });
  });

  it("should handle non-existent GitHub issue links", async () => {
    const result = await checkLinkWithGithubApi("https://github.com/fingerprintjs/fingerprintjs/issues/999999");
    expect(result).toEqual({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "Issue #999999 not found in repository fingerprintjs/fingerprintjs",
    });
  });

  it("should handle GitHub blob links without hash", async () => {
    const result = await checkLinkWithGithubApi("https://github.com/fingerprintjs/fingerprintjs/blob/master/readme.md");
    expect(result).toEqual({
      ok: true,
      status: 200,
    });
  });

  it("should handle GitHub blob links with valid hash", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprintjs/blob/master/readme.md#demo"
    );
    expect(result).toEqual({
      ok: true,
      status: 200,
    });
  });

  it("should handle GitHub blob links with invalid hash", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprintjs/blob/master/readme.md#nonexistent-heading"
    );
    expect(result).toEqual({
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
    expect(result).toEqual({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "File not found in repository",
    });
  });

  it("should return error for unexpected link types", async () => {
    const result = await checkLinkWithGithubApi("https://github.com/fingerprintjs/fingerprintjs/unknown/path");
    expect(result).toEqual({
      ok: false,
      error: "unexpected error",
      status: 400,
      errorDetail: "Unknown link type: unknown/path",
    });
  });
});

describe("checkIfRepositoryExists", () => {
  it("should return success for an existing repository", async () => {
    const result = await checkIfRepositoryExists("fingerprintjs", "fingerprintjs");

    expect(result).toEqual({
      ok: true,
      status: 200,
    });
  });

  it("should return error for a non-existent repository", async () => {
    const result = await checkIfRepositoryExists("fingerprintjs", "nonexistent-repo");

    expect(result).toEqual({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "Repository fingerprintjs/nonexistent-repo not found",
    });
  });
});

describe.only("checkGitHubDiscussionLink", () => {
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
