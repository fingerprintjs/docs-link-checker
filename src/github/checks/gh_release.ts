import type { LinkCheckResult } from "../../types";
import { getErrorStatus } from "../../utils/errors";
import { tryCatch } from "../../utils/tryCatch";
import { getMyOctokit } from "../github_client";

type Octokit = ReturnType<typeof getMyOctokit>;
type RepoParams = { owner: string; repo: string };

const OK: LinkCheckResult = { ok: true, status: 200 };

const brokenLink = (errorDetail: string): LinkCheckResult => ({
  ok: false,
  error: "broken link",
  status: 404,
  errorDetail,
});

/** A 404 from the API is a broken link (with `notFoundDetail`), any other error is unexpected */
const requestErrorResult = (error: Error, notFoundDetail: string): LinkCheckResult =>
  getErrorStatus(error) === 404
    ? brokenLink(notFoundDetail)
    : { ok: false, error: "unexpected error", status: 500, errorDetail: String(error) };

/** `/releases/download/{tag}/{asset}`: the release and its asset exist */
const checkReleaseAsset = async (
  octokit: Octokit,
  { owner, repo }: RepoParams,
  tag: string,
  assetName: string,
): Promise<LinkCheckResult> => {
  const { data: release, error } = await tryCatch(
    octokit.repos.getReleaseByTag({ owner, repo, tag }),
  );
  if (error) {
    return requestErrorResult(error, `Release tag ${tag} not found in repository ${owner}/${repo}`);
  }
  if (!release.data.assets.some((asset) => asset.name === assetName)) {
    return brokenLink(
      `Asset ${assetName} not found in release ${tag} of repository ${owner}/${repo}`,
    );
  }
  return OK;
};

/** `/releases/latest`: the repository has at least one release */
const checkLatestRelease = async (
  octokit: Octokit,
  { owner, repo }: RepoParams,
): Promise<LinkCheckResult> => {
  const { data: releases, error } = await tryCatch(
    octokit.repos.listReleases({ owner, repo, per_page: 1 }),
  );
  if (error) {
    return { ok: false, error: "unexpected error", status: 500, errorDetail: String(error) };
  }
  return releases.data.length === 0 ? brokenLink("No releases found in repository") : OK;
};

/** `/releases/tag/{tag}`: a release with the tag exists */
const checkReleaseTag = async (
  octokit: Octokit,
  { owner, repo }: RepoParams,
  tag: string,
): Promise<LinkCheckResult> => {
  const { error } = await tryCatch(octokit.repos.getReleaseByTag({ owner, repo, tag }));
  return error
    ? requestErrorResult(error, `Release tag ${tag} not found in repository ${owner}/${repo}`)
    : OK;
};

/** `/releases/{id}`: a release with the numeric ID exists */
const checkReleaseId = async (
  octokit: Octokit,
  { owner, repo }: RepoParams,
  releaseId: number,
): Promise<LinkCheckResult> => {
  const { error } = await tryCatch(
    octokit.repos.getRelease({ owner, repo, release_id: releaseId }),
  );
  return error
    ? requestErrorResult(error, `Release #${releaseId} not found in repository ${owner}/${repo}`)
    : OK;
};

/**
 * Check if a GitHub release exists
 * @param owner - The owner of the repository
 * @param repo - The repository name
 * @param pathParts - The path parts of the URL
 * @returns - A LinkCheckResult object
 */
export const checkGitHubReleaseLink = async (
  owner: string,
  repo: string,
  pathParts: string[],
): Promise<LinkCheckResult> => {
  const octokit = getMyOctokit();
  const repoParams = { owner, repo };
  const [, kind = "", ...rest] = pathParts;

  if (kind === "download") {
    const [tag = "", assetName = ""] = rest;
    return checkReleaseAsset(octokit, repoParams, tag, assetName);
  }
  if (kind === "latest") {
    return checkLatestRelease(octokit, repoParams);
  }
  if (kind === "tag") {
    // Tags can contain slashes (`@fingerprint/vue@2.0.0`), written encoded (`%2F`) or not
    return checkReleaseTag(octokit, repoParams, rest.join("/"));
  }
  const releaseId = parseInt(kind, 10);
  if (!Number.isNaN(releaseId)) {
    return checkReleaseId(octokit, repoParams, releaseId);
  }
  return brokenLink("Invalid release URL format");
};
