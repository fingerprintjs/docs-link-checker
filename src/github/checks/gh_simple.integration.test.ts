import { describe, expect, it } from "vitest";
import {
  checkGitHubCommitLink,
  checkGitHubDiscussionLink,
  checkGitHubIssueLink,
  checkGitHubPullRequestLink,
  checkGitHubReleaseLink,
  checkIfRepositoryExists,
} from "./gh_simple";

describe("checkIfRepositoryExists", () => {
  it("should return success for an existing repository", async () => {
    const result = await checkIfRepositoryExists("fingerprintjs", "fingerprintjs");

    expect(result).toMatchObject({ ok: true, status: 200 });
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

describe("checkGitHubCommitLink", () => {
  it("should return success for an existing commit", async () => {
    const result = await checkGitHubCommitLink("fingerprintjs", "fingerprintjs", [
      "commit",
      "9a6c283cdeaee8905d5f085aef180c6ebbbf0e04",
    ]);

    expect(result).toMatchObject({ ok: true, status: 200 });
  });

  it("should return error for a non-existent commit", async () => {
    const result = await checkGitHubCommitLink("fingerprintjs", "fingerprintjs", [
      "commit",
      "0000000000000000000000000000000000000000",
    ]);

    expect(result).toMatchObject({ ok: false, error: "unexpected error" });
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

describe("checkGitHubPullRequestLink", () => {
  it("should return success for an existing pull request", async () => {
    const result = await checkGitHubPullRequestLink("fingerprintjs", "fingerprintjs", [
      "pull",
      "1094",
    ]);

    expect(result).toMatchObject({ ok: true, status: 200 });
  });

  it("should return error for a non-existent pull request", async () => {
    const result = await checkGitHubPullRequestLink("fingerprintjs", "fingerprintjs", [
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
    const result = await checkGitHubPullRequestLink("fingerprintjs", "fingerprintjs", [
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
    const result = await checkGitHubPullRequestLink("fingerprintjs", "nonexistent-repo", [
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

describe("checkGitHubIssueLink", () => {
  it("should return success for an existing issue", async () => {
    const result = await checkGitHubIssueLink("fingerprintjs", "fingerprintjs", ["issues", "1"]);

    expect(result).toMatchObject({ ok: true, status: 200 });
  });

  it("should return success for new issue path", async () => {
    const result = await checkGitHubIssueLink("fingerprintjs", "fingerprintjs", ["issues", "new"]);

    expect(result).toMatchObject({ ok: true, status: 200 });
  });

  it("should return error for a non-existent issue", async () => {
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
      errorDetail: "Invalid issue number format: invalid",
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

describe("checkGitHubDiscussionLink", () => {
  it("should return success for an existing discussion", async () => {
    const result = await checkGitHubDiscussionLink("fingerprintjs", "fingerprintjs", 916);

    expect(result).toMatchObject({ ok: true, status: 200 });
  });

  it("should return broken link for a non-existent discussion", async () => {
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

    expect(result).toMatchObject({ ok: false, error: "broken link", status: 404 });
  });
});

describe("checkGitHubReleaseLink", () => {
  it("should return success for latest release when releases exist", async () => {
    const result = await checkGitHubReleaseLink("fingerprintjs", "fingerprintjs", [
      "releases",
      "latest",
    ]);

    expect(result).toMatchObject({ ok: true, status: 200 });
  });

  it("should return broken link for the latest release of a non-existent repository", async () => {
    const result = await checkGitHubReleaseLink("fingerprintjs", "nonexistent-repo", [
      "releases",
      "latest",
    ]);

    expect(result).toMatchObject({ ok: false, error: "broken link", status: 404 });
  });

  it("should return success for a valid release tag", async () => {
    const result = await checkGitHubReleaseLink("fingerprintjs", "fingerprintjs", [
      "releases",
      "tag",
      "v3.0.0",
    ]);

    expect(result).toMatchObject({ ok: true, status: 200 });
  });

  it("should return error for an invalid release tag", async () => {
    const result = await checkGitHubReleaseLink("fingerprintjs", "fingerprintjs", [
      "releases",
      "tag",
      "nonexistent-tag",
    ]);

    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail:
        "Release tag nonexistent-tag not found in repository fingerprintjs/fingerprintjs",
    });
  });

  it("should return error for invalid release URL format", async () => {
    const result = await checkGitHubReleaseLink("fingerprintjs", "fingerprintjs", [
      "releases",
      "invalid",
    ]);

    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "Invalid release URL format",
    });
  });

  it("should return error for non-existent release asset", async () => {
    const result = await checkGitHubReleaseLink("fingerprintjs", "fingerprintjs", [
      "releases",
      "download",
      "v3.0.0",
      "nonexistent-asset.js",
    ]);

    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail:
        "Asset nonexistent-asset.js not found in release v3.0.0 of repository fingerprintjs/fingerprintjs",
    });
  });

  it("should return error for invalid release ID format", async () => {
    const result = await checkGitHubReleaseLink("fingerprintjs", "fingerprintjs", [
      "releases",
      "invalid-id",
    ]);

    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "Invalid release URL format",
    });
  });
});
