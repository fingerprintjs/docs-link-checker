import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { GitHubApiError } from "../../errors";
import { fakeGitHub } from "../../test/fake_github";
import type { LinkCheckResult } from "../../types";
import type { GitHub, GitHubApi, ReleaseInfo } from "../github_client";
import {
  checkGitHubCommitLink,
  checkGitHubDiscussionLink,
  checkGitHubIssueLink,
  checkGitHubPullRequestLink,
  checkGitHubReleaseLink,
} from "./gh_simple";

const OK = { ok: true, status: 200 };

const apiError = (status: number | undefined, message = `HTTP ${status}`) =>
  new GitHubApiError({ status, cause: new Error(message) });
const failWith = (status: number, message?: string) => () => Effect.fail(apiError(status, message));

/** Runs a check against a fake `GitHub`, returns the result and the API calls it made */
const check = (
  overrides: Partial<GitHubApi>,
  run: Effect.Effect<LinkCheckResult, unknown, GitHub>,
) => {
  const fake = fakeGitHub(overrides);
  return run.pipe(
    Effect.provide(fake.layer),
    Effect.map((result) => ({ result, calls: fake.calls })),
  );
};

describe("checkGitHubCommitLink()", () => {
  const checkCommit = (getCommit: GitHubApi["getCommit"]) =>
    check({ getCommit }, checkGitHubCommitLink("o", "r", ["commit", "0".repeat(40)]));

  it.effect("is OK for an existing commit", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* checkCommit(() => Effect.void);
      expect(result).toEqual(OK);
      expect(calls).toEqual([`getCommit("o", "r", "${"0".repeat(40)}")`]);
    }),
  );

  // GitHub answers an unknown SHA with 422 "No commit found for SHA"
  for (const status of [404, 422]) {
    it.effect(`reports a ${status} as broken link`, () =>
      Effect.gen(function* () {
        const { result } = yield* checkCommit(failWith(status));
        expect(result).toMatchObject({
          ok: false,
          error: "broken link",
          status,
          errorDetail: "Commit not found",
        });
      }),
    );
  }

  it.effect("reports a rate limit (403) as unexpected error", () =>
    Effect.gen(function* () {
      const { result } = yield* checkCommit(failWith(403, "rate limit"));
      expect(result).toMatchObject({ ok: false, error: "unexpected error", status: 403 });
    }),
  );
});

describe("checkGitHubDiscussionLink()", () => {
  const checkDiscussion = (getDiscussion: GitHubApi["getDiscussion"]) =>
    check({ getDiscussion }, checkGitHubDiscussionLink("owner", "repo", 9));

  it.effect("is OK for an existing discussion", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* checkDiscussion(() => Effect.void);
      expect(result).toEqual(OK);
      expect(calls).toEqual(['getDiscussion("owner", "repo", 9)']);
    }),
  );

  // The client maps a GraphQL NOT_FOUND to a 404 (see github_client.test.ts)
  it.effect("is a broken link for a missing discussion or repository", () =>
    Effect.gen(function* () {
      const { result } = yield* checkDiscussion(failWith(404));
      expect(result).toMatchObject({
        ok: false,
        error: "broken link",
        status: 404,
        errorDetail: "Discussion #9 not found in repository owner/repo",
      });
    }),
  );

  for (const [name, status] of [
    ["rate limit", 403],
    ["bad credentials", 401],
    ["server error", 502],
  ] as const) {
    it.effect(`is an unexpected error for a ${name} (${status})`, () =>
      Effect.gen(function* () {
        const { result } = yield* checkDiscussion(failWith(status));
        expect(result).toMatchObject({ ok: false, error: "unexpected error", status });
      }),
    );
  }

  it.effect("is an unexpected error for another GraphQL error (no status)", () =>
    Effect.gen(function* () {
      const { result } = yield* checkDiscussion(() => Effect.fail(apiError(undefined, "oops")));
      expect(result).toMatchObject({ ok: false, error: "unexpected error" });
    }),
  );
});

describe("checkGitHubIssueLink() and checkGitHubPullRequestLink()", () => {
  it.effect("accepts the new issue page without a request", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* check({}, checkGitHubIssueLink("o", "r", ["issues", "new"]));
      expect(result).toEqual(OK);
      expect(calls).toEqual([]);
    }),
  );

  it.effect("reports an issue number that is not a number as broken link, without a request", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* check({}, checkGitHubIssueLink("o", "r", ["issues", "abc"]));
      expect(result).toEqual({
        ok: false,
        error: "broken link",
        errorDetail: "Invalid issue number format: abc",
      });
      expect(calls).toEqual([]);
    }),
  );

  it.effect(
    "reports a pull request number that is not a number as broken link, without a request",
    () =>
      Effect.gen(function* () {
        const { result, calls } = yield* check(
          {},
          checkGitHubPullRequestLink("o", "r", ["pull", "abc"]),
        );
        expect(result).toEqual({
          ok: false,
          error: "broken link",
          status: 404,
          errorDetail: "Invalid pull request number",
        });
        expect(calls).toEqual([]);
      }),
  );

  it.effect("reports a deleted issue (410 Gone) as broken link", () =>
    Effect.gen(function* () {
      const { result } = yield* check(
        { getIssue: failWith(410) },
        checkGitHubIssueLink("o", "r", ["issues", "7"]),
      );
      expect(result).toEqual({
        ok: false,
        error: "broken link",
        status: 410,
        errorDetail: "Issue #7 not found in repository o/r",
      });
    }),
  );

  it.effect("checks existing issues and pull requests by number", () =>
    Effect.gen(function* () {
      const issue = yield* check(
        { getIssue: () => Effect.void },
        checkGitHubIssueLink("o", "r", ["issues", "7"]),
      );
      const pull = yield* check(
        { getPullRequest: () => Effect.void },
        checkGitHubPullRequestLink("o", "r", ["pull", "8"]),
      );
      expect(issue).toEqual({ result: OK, calls: ['getIssue("o", "r", 7)'] });
      expect(pull).toEqual({ result: OK, calls: ['getPullRequest("o", "r", 8)'] });
    }),
  );
});

describe("checkGitHubReleaseLink()", () => {
  const release = (overrides: Partial<GitHubApi>, ...parts: string[]) =>
    check(overrides, checkGitHubReleaseLink("o", "r", ["releases", ...parts]));
  const withAssets = (...names: string[]) => ({
    getReleaseByTag: () => Effect.succeed<ReleaseInfo>({ assets: names.map((name) => ({ name })) }),
  });

  it.effect("accepts an asset that is part of the release", () =>
    Effect.gen(function* () {
      const { result } = yield* release(withAssets("a.zip"), "download", "v1", "a.zip");
      expect(result).toEqual(OK);
    }),
  );

  it.effect("reports an asset that is not part of the release as broken link", () =>
    Effect.gen(function* () {
      const { result } = yield* release(withAssets("a.zip"), "download", "v1", "b.zip");
      expect(result).toEqual({
        ok: false,
        error: "broken link",
        status: 404,
        errorDetail: "Asset b.zip not found in release v1 of repository o/r",
      });
    }),
  );

  it.effect("accepts /releases/latest when the repository has a release", () =>
    Effect.gen(function* () {
      const { result } = yield* release({ hasReleases: () => Effect.succeed(true) }, "latest");
      expect(result).toEqual(OK);
    }),
  );

  it.effect("reports /releases/latest of a repository without releases as broken link", () =>
    Effect.gen(function* () {
      const { result } = yield* release({ hasReleases: () => Effect.succeed(false) }, "latest");
      expect(result).toEqual({
        ok: false,
        error: "broken link",
        status: 404,
        errorDetail: "No releases found in repository",
      });
    }),
  );

  it.effect("reports /releases/latest of a missing repository as broken link", () =>
    Effect.gen(function* () {
      const { result } = yield* release({ hasReleases: failWith(404) }, "latest");
      expect(result).toMatchObject({
        ok: false,
        error: "broken link",
        status: 404,
        errorDetail: "Repository o/r not found",
      });
    }),
  );

  it.effect("checks a release by its numeric ID", () =>
    Effect.gen(function* () {
      const found = yield* release({ getRelease: () => Effect.void }, "123");
      expect(found).toEqual({ result: OK, calls: ['getRelease("o", "r", 123)'] });

      const { result } = yield* release({ getRelease: failWith(404) }, "123");
      expect(result).toMatchObject({
        ok: false,
        error: "broken link",
        errorDetail: "Release #123 not found in repository o/r",
      });
    }),
  );

  it.effect("joins the segments of a tag with slashes", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* release(withAssets(), "tag", "@scope", "pkg@1.0.0");
      expect(result).toEqual(OK);
      expect(calls).toEqual(['getReleaseByTag("o", "r", "@scope/pkg@1.0.0")']);
    }),
  );

  it.effect("reports an unknown release URL as broken link", () =>
    Effect.gen(function* () {
      const { result } = yield* release({}, "invalid");
      expect(result).toEqual({
        ok: false,
        error: "broken link",
        status: 404,
        errorDetail: "Invalid release URL format",
      });
    }),
  );
});
