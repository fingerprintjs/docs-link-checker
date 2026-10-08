/**
 * Existence checks of GitHub links through the API: repository, owner, commit, pull request, issue, discussion,
 * release. Each is "does this API request succeed". A definitive "not found" is a broken link, anything else (rate
 * limit, bad token, network error) an "unexpected error", re-checked in the browser (see `getApiErrorResult`).
 * Only `GitHubTimeout` can fail: it is not a result.
 */
import { Effect } from "effect";
import type { GitHubApiError, GitHubTimeout } from "../../errors";
import type { LinkCheckResult } from "../../types";
import { getApiErrorResult } from "../gh_api";
import { GitHub, type GitHubError } from "../github_client";

const OK: LinkCheckResult = { ok: true, status: 200 };

const brokenLink = (errorDetail: string, status?: number): LinkCheckResult => ({
  ok: false,
  error: "broken link",
  errorDetail,
  ...(status !== undefined ? { status } : {}),
});

/** Turns a failed API request into a result, `onError` can answer specific statuses first */
const toResult =
  (
    notFoundDetail: string,
    onError: (error: GitHubApiError) => LinkCheckResult | undefined = () => undefined,
  ) =>
  <A, R>(effect: Effect.Effect<A, GitHubError, R>) =>
    Effect.catchTag(effect, "GitHubApiError", (error) =>
      Effect.succeed(onError(error) ?? getApiErrorResult(error, notFoundDetail)),
    );

/** `request` resolves if the resource exists */
const checkExists = (
  request: Effect.Effect<unknown, GitHubError>,
  notFoundDetail: string,
): Effect.Effect<LinkCheckResult, GitHubTimeout> =>
  request.pipe(Effect.as(OK), toResult(notFoundDetail));

export const checkIfRepositoryExists = (
  owner: string,
  repo: string,
): Effect.Effect<LinkCheckResult, GitHubTimeout, GitHub> =>
  Effect.flatMap(GitHub, (github) =>
    checkExists(github.getRepo(owner, repo), `Repository ${owner}/${repo} not found`),
  );

/** A user or an organization (`https://github.com/owner`) */
export const checkIfOwnerExists = (
  owner: string,
): Effect.Effect<LinkCheckResult, GitHubTimeout, GitHub> =>
  Effect.flatMap(GitHub, (github) =>
    checkExists(github.getUser(owner), `User or organization ${owner} not found`),
  );

export const checkGitHubCommitLink = (
  owner: string,
  repo: string,
  pathParts: string[],
): Effect.Effect<LinkCheckResult, GitHubTimeout, GitHub> => {
  const [, commit = ""] = pathParts;
  return Effect.flatMap(GitHub, (github) =>
    github.getCommit(owner, repo, commit).pipe(
      Effect.as(OK),
      // Unknown SHA: GitHub answers 422 "No commit found for SHA", not 404. Only true for this endpoint, so 422
      // is not "not found" for every request.
      toResult("Commit not found", (error) =>
        error.status === 422 ? brokenLink("Commit not found", 422) : undefined,
      ),
    ),
  );
};

export const checkGitHubPullRequestLink = (
  owner: string,
  repo: string,
  pathParts: string[],
): Effect.Effect<LinkCheckResult, GitHubTimeout, GitHub> => {
  const [, prNumberPart = ""] = pathParts;
  const prNumber = parseInt(prNumberPart, 10);
  if (Number.isNaN(prNumber)) {
    return Effect.succeed(brokenLink("Invalid pull request number", 404));
  }
  return Effect.flatMap(GitHub, (github) =>
    checkExists(
      github.getPullRequest(owner, repo, prNumber),
      `Pull request #${prNumberPart} not found in repository ${owner}/${repo}`,
    ),
  );
};

export const checkGitHubIssueLink = (
  owner: string,
  repo: string,
  pathParts: string[],
): Effect.Effect<LinkCheckResult, GitHubTimeout, GitHub> => {
  const [, issueNumberPart = ""] = pathParts;
  if (issueNumberPart === "new") {
    return Effect.succeed(OK);
  }
  const issueNumber = parseInt(issueNumberPart, 10);
  if (Number.isNaN(issueNumber)) {
    return Effect.succeed(brokenLink(`Invalid issue number format: ${issueNumberPart}`));
  }
  // A deleted issue answers 410
  return Effect.flatMap(GitHub, (github) =>
    checkExists(
      github.getIssue(owner, repo, issueNumber),
      `Issue #${issueNumber} not found in repository ${owner}/${repo}`,
    ),
  );
};

export const checkGitHubDiscussionLink = (
  owner: string,
  repo: string,
  discussionNumber: number,
): Effect.Effect<LinkCheckResult, GitHubTimeout, GitHub> =>
  Effect.flatMap(GitHub, (github) =>
    checkExists(
      github.getDiscussion(owner, repo, discussionNumber),
      `Discussion #${discussionNumber} not found in repository ${owner}/${repo}`,
    ),
  );

export const checkGitHubReleaseLink = Effect.fn("github.checkReleaseLink")(function* (
  owner: string,
  repo: string,
  pathParts: string[],
) {
  const github = yield* GitHub;
  const [, kind = "", ...rest] = pathParts;

  // `/releases/download/{tag}/{asset}`: the release and its asset exist
  if (kind === "download") {
    const [tag = "", assetName = ""] = rest;
    return yield* github.getReleaseByTag(owner, repo, tag).pipe(
      Effect.map((release) =>
        release.assets.some((asset) => asset.name === assetName)
          ? OK
          : brokenLink(
              `Asset ${assetName} not found in release ${tag} of repository ${owner}/${repo}`,
              404,
            ),
      ),
      toResult(`Release tag ${tag} not found in repository ${owner}/${repo}`),
    );
  }
  // `/releases/latest`: the repository has at least one release
  if (kind === "latest") {
    return yield* github.hasReleases(owner, repo).pipe(
      Effect.map((has) => (has ? OK : brokenLink("No releases found in repository", 404))),
      toResult(`Repository ${owner}/${repo} not found`),
    );
  }
  if (kind === "tag") {
    // Tags can contain slashes (`@fingerprint/vue@2.0.0`), written encoded (`%2F`) or not
    const tag = rest.join("/");
    return yield* checkExists(
      github.getReleaseByTag(owner, repo, tag),
      `Release tag ${tag} not found in repository ${owner}/${repo}`,
    );
  }
  const releaseId = parseInt(kind, 10);
  if (!Number.isNaN(releaseId)) {
    return yield* checkExists(
      github.getRelease(owner, repo, releaseId),
      `Release #${releaseId} not found in repository ${owner}/${repo}`,
    );
  }
  return brokenLink("Invalid release URL format", 404);
});
