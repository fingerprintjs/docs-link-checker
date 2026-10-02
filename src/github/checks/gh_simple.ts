import type { LinkCheckResult } from "../../types";
import { tryCatch } from "../../utils/tryCatch";
import { getApiErrorResult, isNotFoundApiError } from "../gh_api_error";
import { getRepoCached, getUserCached } from "../gh_cache";
import { getMyOctokit } from "../github_client";

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

/** Checks that `request` resolves (the resource exists); `notFoundDetail` is used for a definitive "not found" */
const checkExists = async (
  request: Promise<unknown>,
  notFoundDetail: string,
): Promise<LinkCheckResult> => {
  const { error } = await tryCatch(request);
  return error ? getApiErrorResult(error, notFoundDetail) : OK;
};

export const checkIfRepositoryExists = (owner: string, repo: string): Promise<LinkCheckResult> =>
  checkExists(getRepoCached(owner, repo), `Repository ${owner}/${repo} not found`);

/** `GET /users/{owner}` works for both a user and an organization (`https://github.com/owner`) */
export const checkIfOwnerExists = (owner: string): Promise<LinkCheckResult> =>
  checkExists(getUserCached(owner), `User or organization ${owner} not found`);

export const checkGitHubCommitLink = (
  owner: string,
  repo: string,
  pathParts: string[],
): Promise<LinkCheckResult> => {
  const [, commit = ""] = pathParts;
  return checkExists(
    getMyOctokit().repos.getCommit({ owner, repo, ref: commit }),
    "Commit not found",
  );
};

export const checkGitHubPullRequestLink = (
  owner: string,
  repo: string,
  pathParts: string[],
): Promise<LinkCheckResult> => {
  const [, prNumberPart = ""] = pathParts;
  const prNumber = parseInt(prNumberPart, 10);
  if (Number.isNaN(prNumber)) {
    return Promise.resolve(brokenLink("Invalid pull request number", 404));
  }
  return checkExists(
    getMyOctokit().pulls.get({ owner, repo, pull_number: prNumber }),
    `Pull request #${prNumberPart} not found in repository ${owner}/${repo}`,
  );
};

export const checkGitHubIssueLink = (
  owner: string,
  repo: string,
  pathParts: string[],
): Promise<LinkCheckResult> => {
  const [, issueNumberPart = ""] = pathParts;
  if (issueNumberPart === "new") {
    return Promise.resolve(OK);
  }
  const issueNumber = parseInt(issueNumberPart, 10);
  if (Number.isNaN(issueNumber)) {
    return Promise.resolve(brokenLink(`Invalid issue number format: ${issueNumberPart}`));
  }
  // 410: the issue was deleted
  return checkExists(
    getMyOctokit().issues.get({ owner, repo, issue_number: issueNumber }),
    `Issue #${issueNumber} not found in repository ${owner}/${repo}`,
  );
};

/** `true` for a GraphQL "Could not resolve to a Repository/Discussion" (NOT_FOUND) error */
const isGraphqlNotFound = (error: unknown): boolean => {
  const { errors, message } = (error ?? {}) as { errors?: { type?: string }[]; message?: string };
  return (
    errors?.some((e) => e.type === "NOT_FOUND") === true ||
    /Could not resolve to a (Discussion|Repository)/.test(message ?? "")
  );
};

export const checkGitHubDiscussionLink = async (
  owner: string,
  repo: string,
  discussionNumber: number,
): Promise<LinkCheckResult> => {
  const { data, error } = await tryCatch(
    getMyOctokit().graphql(
      `query ($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          discussion(number: $number) {
            id
          }
        }
      }`,
      { owner, repo, number: discussionNumber },
    ),
  );
  if (data) {
    return OK;
  }
  const notFoundDetail = `Discussion #${discussionNumber} not found in repository ${owner}/${repo}`;
  // GraphQL answers a missing discussion or repository with a NOT_FOUND error in a 200 response
  if (isNotFoundApiError(error) || isGraphqlNotFound(error)) {
    return brokenLink(notFoundDetail, 404);
  }
  return getApiErrorResult(error, notFoundDetail);
};

type RepoParams = { owner: string; repo: string };

/** `/releases/download/{tag}/{asset}`: the release and its asset exist */
const checkReleaseAsset = async (
  { owner, repo }: RepoParams,
  tag: string,
  assetName: string,
): Promise<LinkCheckResult> => {
  const { data: release, error } = await tryCatch(
    getMyOctokit().repos.getReleaseByTag({ owner, repo, tag }),
  );
  if (error) {
    return getApiErrorResult(error, `Release tag ${tag} not found in repository ${owner}/${repo}`);
  }
  return release.data.assets.some((asset) => asset.name === assetName)
    ? OK
    : brokenLink(
        `Asset ${assetName} not found in release ${tag} of repository ${owner}/${repo}`,
        404,
      );
};

/** `/releases/latest`: the repository has at least one release */
const checkLatestRelease = async ({ owner, repo }: RepoParams): Promise<LinkCheckResult> => {
  const { data: releases, error } = await tryCatch(
    getMyOctokit().repos.listReleases({ owner, repo, per_page: 1 }),
  );
  if (error) {
    return getApiErrorResult(error, `Repository ${owner}/${repo} not found`);
  }
  return releases.data.length === 0 ? brokenLink("No releases found in repository", 404) : OK;
};

export const checkGitHubReleaseLink = (
  owner: string,
  repo: string,
  pathParts: string[],
): Promise<LinkCheckResult> => {
  const repoParams = { owner, repo };
  const [, kind = "", ...rest] = pathParts;

  if (kind === "download") {
    const [tag = "", assetName = ""] = rest;
    return checkReleaseAsset(repoParams, tag, assetName);
  }
  if (kind === "latest") {
    return checkLatestRelease(repoParams);
  }
  if (kind === "tag") {
    // Tags can contain slashes (`@fingerprint/vue@2.0.0`), written encoded (`%2F`) or not
    const tag = rest.join("/");
    return checkExists(
      getMyOctokit().repos.getReleaseByTag({ owner, repo, tag }),
      `Release tag ${tag} not found in repository ${owner}/${repo}`,
    );
  }
  const releaseId = parseInt(kind, 10);
  if (!Number.isNaN(releaseId)) {
    return checkExists(
      getMyOctokit().repos.getRelease({ owner, repo, release_id: releaseId }),
      `Release #${releaseId} not found in repository ${owner}/${repo}`,
    );
  }
  return Promise.resolve(brokenLink("Invalid release URL format", 404));
};
