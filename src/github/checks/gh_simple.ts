import { Effect } from "effect";
import type { LinkCheckResult } from "../../types";
import { cachedRequest, getApiErrorResult, getRepoCached, isNotFoundApiError } from "../gh_api";
import { type GitHubApiError, githubRequest } from "../github_client";

/**
 * GitHub resource checks that are each just "does this API request succeed": a repository, a user/organization,
 * a commit, a pull request, an issue, a discussion and a release. A definitive "not found" (404/410, or GraphQL's
 * own NOT_FOUND for discussions) is a broken link, anything else (rate limit, bad token, network error) is an
 * "unexpected error", re-checked in the browser (see `getApiErrorResult`).
 */

const OK: LinkCheckResult = { ok: true, status: 200 };

const brokenLink = (errorDetail: string, status?: number): LinkCheckResult => ({
  ok: false,
  error: "broken link",
  errorDetail,
  ...(status !== undefined ? { status } : {}),
});

/**
 * Checks that `request` succeeds (the resource exists), `toResult` can judge the response further.
 * `notFoundDetail` is used for a definitive "not found".
 */
const checkExists = <A, R>(
  request: Effect.Effect<A, GitHubApiError, R>,
  notFoundDetail: string,
  toResult: (response: A) => LinkCheckResult = () => OK,
) =>
  request.pipe(
    Effect.map(toResult),
    Effect.catchTag("GitHubApiError", (error) =>
      Effect.succeed(getApiErrorResult(error, notFoundDetail)),
    ),
  );

export const checkIfRepositoryExists = (owner: string, repo: string) =>
  checkExists(getRepoCached(owner, repo), `Repository ${owner}/${repo} not found`);

/** `GET /users/{owner}` works for both a user and an organization (`https://github.com/owner`) */
export const checkIfOwnerExists = (owner: string) =>
  checkExists(
    // Users and organizations, names are case-insensitive
    cachedRequest(["user", owner.toLowerCase()], (octokit) =>
      octokit.users.getByUsername({ username: owner }),
    ),
    `User or organization ${owner} not found`,
  );

export const checkGitHubCommitLink = (owner: string, repo: string, pathParts: string[]) => {
  const [, commit = ""] = pathParts;
  return githubRequest((octokit) => octokit.repos.getCommit({ owner, repo, ref: commit })).pipe(
    Effect.as(OK),
    Effect.catchTag("GitHubApiError", (error) =>
      Effect.succeed(
        // Unknown SHA: GitHub answers 422 "No commit found for SHA", not 404. Only true for this endpoint, so 422 is
        // not treated as "not found" globally (see `isNotFoundApiError`).
        error.status === 422
          ? brokenLink("Commit not found", 422)
          : getApiErrorResult(error, "Commit not found"),
      ),
    ),
  );
};

export const checkGitHubPullRequestLink = (owner: string, repo: string, pathParts: string[]) => {
  const [, prNumberPart = ""] = pathParts;
  const prNumber = parseInt(prNumberPart, 10);
  if (Number.isNaN(prNumber)) {
    return Effect.succeed(brokenLink("Invalid pull request number", 404));
  }
  return checkExists(
    githubRequest((octokit) => octokit.pulls.get({ owner, repo, pull_number: prNumber })),
    `Pull request #${prNumberPart} not found in repository ${owner}/${repo}`,
  );
};

export const checkGitHubIssueLink = (owner: string, repo: string, pathParts: string[]) => {
  const [, issueNumberPart = ""] = pathParts;
  if (issueNumberPart === "new") {
    return Effect.succeed(OK);
  }
  const issueNumber = parseInt(issueNumberPart, 10);
  if (Number.isNaN(issueNumber)) {
    return Effect.succeed(brokenLink(`Invalid issue number format: ${issueNumberPart}`));
  }
  // 410: the issue was deleted
  return checkExists(
    githubRequest((octokit) => octokit.issues.get({ owner, repo, issue_number: issueNumber })),
    `Issue #${issueNumber} not found in repository ${owner}/${repo}`,
  );
};

/** `true` for a GraphQL "Could not resolve to a Repository/Discussion" (NOT_FOUND) error */
const isGraphqlNotFound = ({ cause }: GitHubApiError): boolean => {
  const { errors, message } = (cause ?? {}) as { errors?: { type?: string }[]; message?: string };
  return (
    errors?.some((e) => e.type === "NOT_FOUND") === true ||
    /Could not resolve to a (Discussion|Repository)/.test(message ?? "")
  );
};

export const checkGitHubDiscussionLink = (
  owner: string,
  repo: string,
  discussionNumber: number,
) => {
  const notFoundDetail = `Discussion #${discussionNumber} not found in repository ${owner}/${repo}`;
  return githubRequest((octokit) =>
    octokit.graphql(
      `query ($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          discussion(number: $number) {
            id
          }
        }
      }`,
      { owner, repo, number: discussionNumber },
    ),
  ).pipe(
    Effect.as(OK),
    Effect.catchTag("GitHubApiError", (error) =>
      Effect.succeed(
        // GraphQL answers a missing discussion or repository with a NOT_FOUND error in a 200 response
        isNotFoundApiError(error) || isGraphqlNotFound(error)
          ? brokenLink(notFoundDetail, 404)
          : getApiErrorResult(error, notFoundDetail),
      ),
    ),
  );
};

export const checkGitHubReleaseLink = (owner: string, repo: string, pathParts: string[]) => {
  const [, kind = "", ...rest] = pathParts;

  // `/releases/download/{tag}/{asset}`: the release and its asset exist
  if (kind === "download") {
    const [tag = "", assetName = ""] = rest;
    return checkExists(
      githubRequest((octokit) => octokit.repos.getReleaseByTag({ owner, repo, tag })),
      `Release tag ${tag} not found in repository ${owner}/${repo}`,
      (release) =>
        release.data.assets.some((asset) => asset.name === assetName)
          ? OK
          : brokenLink(
              `Asset ${assetName} not found in release ${tag} of repository ${owner}/${repo}`,
              404,
            ),
    );
  }
  // `/releases/latest`: the repository has at least one release
  if (kind === "latest") {
    return checkExists(
      githubRequest((octokit) => octokit.repos.listReleases({ owner, repo, per_page: 1 })),
      `Repository ${owner}/${repo} not found`,
      (releases) =>
        releases.data.length === 0 ? brokenLink("No releases found in repository", 404) : OK,
    );
  }
  if (kind === "tag") {
    // Tags can contain slashes (`@fingerprint/vue@2.0.0`), written encoded (`%2F`) or not
    const tag = rest.join("/");
    return checkExists(
      githubRequest((octokit) => octokit.repos.getReleaseByTag({ owner, repo, tag })),
      `Release tag ${tag} not found in repository ${owner}/${repo}`,
    );
  }
  const releaseId = parseInt(kind, 10);
  if (!Number.isNaN(releaseId)) {
    return checkExists(
      githubRequest((octokit) => octokit.repos.getRelease({ owner, repo, release_id: releaseId })),
      `Release #${releaseId} not found in repository ${owner}/${repo}`,
    );
  }
  return Effect.succeed(brokenLink("Invalid release URL format", 404));
};
