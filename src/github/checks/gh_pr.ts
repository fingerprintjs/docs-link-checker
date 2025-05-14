import { LinkCheckResult } from "../../types";
import { getMyOctokit } from "../github_client";

const octokit = getMyOctokit();

/**
 * Check if a GitHub pull request exists
 * @param fullUrl - The full URL of the pull request
 * @param owner - The owner of the repository
 * @param repo - The repository name
 * @param pathParts - The path parts of the URL
 * @returns - A LinkCheckResult object
 */
export const checkGitHubPullRequestLink = async (
  fullUrl: URL,
  owner: string,
  repo: string,
  pathParts: string[]
): Promise<LinkCheckResult> => {
  try {
    const prNumber = parseInt(pathParts[1], 10);
    if (isNaN(prNumber)) {
      return {
        ok: false,
        error: "broken link",
        status: 404,
        errorDetail: "Invalid pull request number",
      };
    }

    await octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    return { ok: true, status: 200 };
  } catch (error: any) {
    if (error.status === 404) {
      return {
        ok: false,
        error: "broken link",
        status: 404,
        errorDetail: `Pull request #${pathParts[1]} not found in repository ${owner}/${repo}`,
      };
    }
    if (error.status === 429) {
      return {
        ok: false,
        error: "unexpected error",
        status: 429,
        errorDetail: "GitHub API rate limit exceeded",
      };
    }
    return {
      ok: false,
      error: "unexpected error",
      status: 500,
      errorDetail: String(error),
    };
  }
};
