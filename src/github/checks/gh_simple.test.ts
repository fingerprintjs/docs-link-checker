import { beforeEach, describe, expect, it, vi } from "vitest";

const { octokit } = vi.hoisted(() => ({
  octokit: {
    graphql: vi.fn(),
    issues: { get: vi.fn() },
    pulls: { get: vi.fn() },
    repos: {
      getCommit: vi.fn(),
      getRelease: vi.fn(),
      getReleaseByTag: vi.fn(),
      listReleases: vi.fn(),
    },
  },
}));

vi.mock("../github_client", () => ({ getMyOctokit: () => octokit }));

import {
  checkGitHubCommitLink,
  checkGitHubDiscussionLink,
  checkGitHubIssueLink,
  checkGitHubPullRequestLink,
  checkGitHubReleaseLink,
} from "./gh_simple";

const signal = new AbortController().signal;

const OK = { ok: true, status: 200 };
const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });

// GraphQL answers a missing repository or discussion with errors in a 200 response
const graphqlError = (message: string, type?: string) =>
  Object.assign(new Error(message), { errors: [{ type, message }] });

beforeEach(() => {
  for (const fn of [
    octokit.graphql,
    octokit.issues.get,
    octokit.pulls.get,
    octokit.repos.getCommit,
    octokit.repos.getRelease,
    octokit.repos.getReleaseByTag,
    octokit.repos.listReleases,
  ]) {
    fn.mockReset();
    fn.mockResolvedValue({ data: {} });
  }
});

describe("checkGitHubCommitLink(, signal)", () => {
  const check = () => checkGitHubCommitLink("o", "r", ["commit", "0".repeat(40)], signal);

  it("is OK for an existing commit", async () => {
    expect(await check()).toEqual(OK);
  });

  it.each([
    ["404", 404],
    // GitHub answers an unknown SHA with 422 "No commit found for SHA"
    ["422", 422],
  ])("reports a %s as broken link", async (_, status) => {
    octokit.repos.getCommit.mockRejectedValue(Object.assign(new Error("nope"), { status }));
    expect(await check()).toMatchObject({
      ok: false,
      error: "broken link",
      status,
      errorDetail: "Commit not found",
    });
  });

  it("reports a rate limit (403) as unexpected error", async () => {
    octokit.repos.getCommit.mockRejectedValue(
      Object.assign(new Error("rate limit"), { status: 403 }),
    );
    expect(await check()).toMatchObject({
      ok: false,
      error: "unexpected error",
      status: 403,
    });
  });
});

describe("checkGitHubDiscussionLink(, signal)", () => {
  const check = () => checkGitHubDiscussionLink("owner", "repo", 9, signal);

  it("is OK for an existing discussion", async () => {
    octokit.graphql.mockResolvedValue({
      repository: { discussion: { id: "D_1" } },
    });
    expect(await check()).toEqual(OK);
  });

  it.each([
    [
      "missing discussion",
      graphqlError("Could not resolve to a Discussion with the number of 9.", "NOT_FOUND"),
    ],
    [
      "missing repository",
      graphqlError("Could not resolve to a Repository with the name 'owner/x'.", "NOT_FOUND"),
    ],
    ["NOT_FOUND type only", graphqlError("Something else", "NOT_FOUND")],
    ["message only", new Error("Could not resolve to a Repository with the name 'a/b'.")],
  ])("is a broken link for a %s", async (_, error) => {
    octokit.graphql.mockRejectedValue(error);
    expect(await check()).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
    });
  });

  it.each([
    ["rate limit (403)", Object.assign(new Error("API rate limit exceeded"), { status: 403 })],
    ["bad credentials (401)", Object.assign(new Error("Bad credentials"), { status: 401 })],
    ["server error (502)", Object.assign(new Error("Bad Gateway"), { status: 502 })],
    ["other GraphQL error", graphqlError("Something went wrong", "INTERNAL")],
  ])("is an unexpected error for a %s", async (_, error) => {
    octokit.graphql.mockRejectedValue(error);
    expect(await check()).toMatchObject({
      ok: false,
      error: "unexpected error",
    });
  });
});

describe("checkGitHubIssueLink(, signal) and checkGitHubPullRequestLink(, signal)", () => {
  it("accepts the new issue page without a request", async () => {
    expect(await checkGitHubIssueLink("o", "r", ["issues", "new"], signal)).toEqual(OK);
    expect(octokit.issues.get).not.toHaveBeenCalled();
  });

  it("reports an issue number that is not a number as broken link, without a request", async () => {
    expect(await checkGitHubIssueLink("o", "r", ["issues", "abc"], signal)).toEqual({
      ok: false,
      error: "broken link",
      errorDetail: "Invalid issue number format: abc",
    });
    expect(octokit.issues.get).not.toHaveBeenCalled();
  });

  it("reports a pull request number that is not a number as broken link, without a request", async () => {
    expect(await checkGitHubPullRequestLink("o", "r", ["pull", "abc"], signal)).toEqual({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "Invalid pull request number",
    });
    expect(octokit.pulls.get).not.toHaveBeenCalled();
  });
});

describe("checkGitHubReleaseLink(, signal)", () => {
  const release = (...parts: string[]) =>
    checkGitHubReleaseLink("o", "r", ["releases", ...parts], signal);

  it("accepts an asset that is part of the release", async () => {
    octokit.repos.getReleaseByTag.mockResolvedValue({
      data: { assets: [{ name: "a.zip" }] },
    });

    expect(await release("download", "v1", "a.zip")).toEqual(OK);
  });

  it("reports an asset that is not part of the release as broken link", async () => {
    octokit.repos.getReleaseByTag.mockResolvedValue({
      data: { assets: [{ name: "a.zip" }] },
    });

    expect(await release("download", "v1", "b.zip")).toEqual({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "Asset b.zip not found in release v1 of repository o/r",
    });
  });

  it("accepts /releases/latest when the repository has a release", async () => {
    octokit.repos.listReleases.mockResolvedValue({ data: [{ id: 1 }] });

    expect(await release("latest")).toEqual(OK);
  });

  it("reports /releases/latest of a repository without releases as broken link", async () => {
    octokit.repos.listReleases.mockResolvedValue({ data: [] });

    expect(await release("latest")).toEqual({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "No releases found in repository",
    });
  });

  it("checks a release by its numeric ID", async () => {
    expect(await release("123")).toEqual(OK);
    expect(octokit.repos.getRelease).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      release_id: 123,
      request: { signal: expect.any(AbortSignal) },
    });

    octokit.repos.getRelease.mockRejectedValue(notFound());
    expect(await release("123")).toMatchObject({
      ok: false,
      error: "broken link",
      errorDetail: "Release #123 not found in repository o/r",
    });
  });

  it("joins the segments of a tag with slashes", async () => {
    expect(await release("tag", "@scope", "pkg@1.0.0")).toEqual(OK);
    expect(octokit.repos.getReleaseByTag).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      tag: "@scope/pkg@1.0.0",
      request: { signal: expect.any(AbortSignal) },
    });
  });

  it("reports an unknown release URL as broken link", async () => {
    expect(await release("invalid")).toEqual({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "Invalid release URL format",
    });
  });
});
