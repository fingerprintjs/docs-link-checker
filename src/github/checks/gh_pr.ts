import type { RequestError } from "@octokit/types";
import type { LinkCheckResult } from "../../types";
import { tryCatch } from "../../utils/tryCatch";
import { getMyOctokit } from "../github_client";

/**
 * Check if a GitHub pull request exists
 * @param fullUrl - The full URL of the pull request
 * @param owner - The owner of the repository
 * @param repo - The repository name
 * @param pathParts - The path parts of the URL
 * @returns - A LinkCheckResult object
 */
export const checkGitHubPullRequestLink = async (
  owner: string,
  repo: string,
  pathParts: string[]
): Promise<LinkCheckResult> => {
  const octokit = getMyOctokit();
  const prNumber = parseInt(pathParts[1], 10);
  if (Number.isNaN(prNumber)) {
    return {
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "Invalid pull request number",
    };
  }

  const { error } = await tryCatch(
    octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    })
  );

  if (error) {
    const requestError = error as unknown as RequestError;
    if (requestError.status === 404) {
      return {
        ok: false,
        error: "broken link",
        status: 404,
        errorDetail: `Pull request #${pathParts[1]} not found in repository ${owner}/${repo}`,
      };
    }
    if (requestError.status === 429) {
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

  return { ok: true, status: 200 };
};
