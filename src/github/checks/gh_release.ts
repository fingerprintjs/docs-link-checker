import type { RequestError } from "@octokit/types";
import type { LinkCheckResult } from "../../types";
import { tryCatch } from "../../utils/tryCatch";
import { getMyOctokit } from "../github_client";

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
  // If pathParts[1] is "download", check if the release asset exists
  if (pathParts[1] === "download") {
    const tag = pathParts[2];
    const assetName = pathParts[3];

    const { data: release, error: releaseError } = await tryCatch(
      octokit.repos.getReleaseByTag({
        owner,
        repo,
        tag,
      }),
    );

    if (releaseError) {
      const requestError = releaseError as unknown as RequestError;
      if (requestError.status === 404) {
        return {
          ok: false,
          error: "broken link",
          status: 404,
          errorDetail: `Release tag ${tag} not found in repository ${owner}/${repo}`,
        };
      }
      return {
        ok: false,
        error: "unexpected error",
        status: 500,
        errorDetail: String(releaseError),
      };
    }

    // Then check if the asset exists
    const asset = release.data.assets.find((a) => a.name === assetName);
    if (!asset) {
      return {
        ok: false,
        error: "broken link",
        status: 404,
        errorDetail: `Asset ${assetName} not found in release ${tag} of repository ${owner}/${repo}`,
      };
    }

    return { ok: true, status: 200 };
  }

  // If pathParts[1] is "latest", check if any release exists
  if (pathParts[1] === "latest") {
    const { data: releases, error } = await tryCatch(
      octokit.repos.listReleases({
        owner,
        repo,
        per_page: 1,
      }),
    );

    if (error) {
      return {
        ok: false,
        error: "unexpected error",
        status: 500,
        errorDetail: String(error),
      };
    }

    if (releases.data.length === 0) {
      return {
        ok: false,
        error: "broken link",
        status: 404,
        errorDetail: "No releases found in repository",
      };
    }

    return { ok: true, status: 200 };
  }

  // If pathParts[1] is "tag", check if the specific tag exists
  if (pathParts[1] === "tag") {
    const tag = pathParts[2];
    const { error } = await tryCatch(
      octokit.repos.getReleaseByTag({
        owner,
        repo,
        tag,
      }),
    );

    if (error) {
      const requestError = error as unknown as RequestError;
      if (requestError.status === 404) {
        return {
          ok: false,
          error: "broken link",
          status: 404,
          errorDetail: `Release tag ${tag} not found in repository ${owner}/${repo}`,
        };
      }
      return {
        ok: false,
        error: "unexpected error",
        status: 500,
        errorDetail: String(error),
      };
    }

    return { ok: true, status: 200 };
  }

  // If pathParts[1] is a number, check if the specific release exists
  const releaseId = parseInt(pathParts[1], 10);
  if (!Number.isNaN(releaseId)) {
    const { error } = await tryCatch(
      octokit.repos.getRelease({
        owner,
        repo,
        release_id: releaseId,
      }),
    );

    if (error) {
      const requestError = error as unknown as RequestError;
      if (requestError.status === 404) {
        return {
          ok: false,
          error: "broken link",
          status: 404,
          errorDetail: `Release #${releaseId} not found in repository ${owner}/${repo}`,
        };
      }
      return {
        ok: false,
        error: "unexpected error",
        status: 500,
        errorDetail: String(error),
      };
    }

    return { ok: true, status: 200 };
  }

  return {
    ok: false,
    error: "broken link",
    status: 404,
    errorDetail: "Invalid release URL format",
  };
};
