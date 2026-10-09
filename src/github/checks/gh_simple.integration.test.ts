import { describe, expect, it } from "vitest";
import {
  checkGitHubCommitLink,
  checkGitHubDiscussionLink,
  checkGitHubReleaseLink,
  checkIfOwnerExists,
} from "./gh_simple";

const signal = new AbortController().signal;

// Cases that gh_check_link.integration.test.ts does not cover: responses of the real API that unit tests can only
// fake (missing repositories, commits, `latest` release)

describe("checkIfOwnerExists", () => {
  it("reports a user or organization that does not exist as broken link", async () => {
    const result = await checkIfOwnerExists("fingerprintjs-nonexistent-owner-xyz", signal);

    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "User or organization fingerprintjs-nonexistent-owner-xyz not found",
    });
  });
});

describe("checkGitHubCommitLink", () => {
  it("reports a commit SHA that does not exist as broken link", async () => {
    // GitHub answers 422 "No commit found for SHA" instead of 404
    const result = await checkGitHubCommitLink(
      "fingerprintjs",
      "fingerprintjs",
      ["commit", "0000000000000000000000000000000000000000"],
      signal,
    );

    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 422,
      errorDetail: "Commit not found",
    });
  });

  it("reports a commit of a repository that does not exist as broken link", async () => {
    const result = await checkGitHubCommitLink(
      "fingerprintjs",
      "nonexistent-repo",
      ["commit", "9a6c283cdeaee8905d5f085aef180c6ebbbf0e04"],
      signal,
    );

    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "Commit not found",
    });
  });
});

describe("checkGitHubDiscussionLink", () => {
  it("reports a discussion of a repository that does not exist as broken link", async () => {
    const result = await checkGitHubDiscussionLink("fingerprintjs", "nonexistent-repo", 1, signal);

    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
    });
  });
});

describe("checkGitHubReleaseLink", () => {
  it("accepts the latest release of a repository with releases", async () => {
    const result = await checkGitHubReleaseLink(
      "fingerprintjs",
      "fingerprintjs",
      ["releases", "latest"],
      signal,
    );

    expect(result).toMatchObject({ ok: true, status: 200 });
  });

  it("reports the latest release of a repository that does not exist as broken link", async () => {
    const result = await checkGitHubReleaseLink(
      "fingerprintjs",
      "nonexistent-repo",
      ["releases", "latest"],
      signal,
    );

    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
    });
  });
});
