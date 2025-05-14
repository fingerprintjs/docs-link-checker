import { LinkCheckResult } from "../../types";
import { getMyOctokit } from "../github_client";

const octokit = getMyOctokit();

/**
 * Check if a GitHub release exists
 * @param fullUrl - The full URL of the release
 * @param owner - The owner of the repository
 * @param repo - The repository name
 * @param pathParts - The path parts of the URL
 * @returns - A LinkCheckResult object
 */
export const checkGitHubReleaseLink = async (
  fullUrl: URL,
  owner: string,
  repo: string,
  pathParts: string[]
): Promise<LinkCheckResult> => {
  try {
    // If pathParts[1] is "download", check if the release asset exists
    if (pathParts[1] === "download") {
      const tag = pathParts[2];
      const assetName = pathParts[3];

      try {
        // First check if the release exists
        const { data: release } = await octokit.repos.getReleaseByTag({
          owner,
          repo,
          tag,
        });

        // Then check if the asset exists
        const asset = release.assets.find((a) => a.name === assetName);
        if (!asset) {
          return {
            ok: false,
            error: "broken link",
            status: 404,
            errorDetail: `Asset ${assetName} not found in release ${tag} of repository ${owner}/${repo}`,
          };
        }

        return { ok: true, status: 200 };
      } catch (error: any) {
        if (error.status === 404) {
          return {
            ok: false,
            error: "broken link",
            status: 404,
            errorDetail: `Release tag ${tag} not found in repository ${owner}/${repo}`,
          };
        }
        throw error;
      }
    }

    // If pathParts[1] is "latest", check if any release exists
    if (pathParts[1] === "latest") {
      const { data: releases } = await octokit.repos.listReleases({
        owner,
        repo,
        per_page: 1,
      });

      if (releases.length === 0) {
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
      try {
        await octokit.repos.getReleaseByTag({
          owner,
          repo,
          tag,
        });
        return { ok: true, status: 200 };
      } catch (error: any) {
        if (error.status === 404) {
          return {
            ok: false,
            error: "broken link",
            status: 404,
            errorDetail: `Release tag ${tag} not found in repository ${owner}/${repo}`,
          };
        }
        throw error;
      }
    }

    // If pathParts[1] is a number, check if the specific release exists
    const releaseId = parseInt(pathParts[1], 10);
    if (!isNaN(releaseId)) {
      try {
        await octokit.repos.getRelease({
          owner,
          repo,
          release_id: releaseId,
        });
        return { ok: true, status: 200 };
      } catch (error: any) {
        if (error.status === 404) {
          return {
            ok: false,
            error: "broken link",
            status: 404,
            errorDetail: `Release #${releaseId} not found in repository ${owner}/${repo}`,
          };
        }
        throw error;
      }
    }

    return {
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "Invalid release URL format",
    };
  } catch (error: any) {
    return {
      ok: false,
      error: "unexpected error",
      status: 500,
      errorDetail: String(error),
    };
  }
};
