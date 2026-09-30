import type { RequestError } from "@octokit/types";
import type { LinkCheckResult } from "../../types";
import { tryCatch } from "../../utils/tryCatch";
import { getContentCached } from "../gh_cache";
import { getMyOctokit } from "../github_client";

/**
 * Check if a GitHub branch/tree exists
 * @param owner - The owner of the repository
 * @param repo - The repository name
 * @param pathParts - The path parts of the URL
 * @returns - A LinkCheckResult object
 */
export const checkGitHubTreeLink = async (
  owner: string,
  repo: string,
  pathParts: string[],
): Promise<LinkCheckResult> => {
  const octokit = getMyOctokit();
  const [, branch, ...restOfPath] = pathParts;
  const path = restOfPath.join("/");

  // If there's no path specified, we just check if the branch/commit exists
  if (!path) {
    // Try as a branch name first
    const branchResult = await tryCatch(
      octokit.git.getRef({
        owner,
        repo,
        ref: `heads/${branch}`,
      }),
    );

    if (branchResult.data) {
      return { ok: true, status: 200 };
    }

    // If branch check fails, try as a commit hash
    const commitResult = await tryCatch(
      octokit.git.getCommit({
        owner,
        repo,
        commit_sha: branch,
      }),
    );

    if (commitResult.data) {
      console.log("no path specified, commit exists");
      return { ok: true, status: 200 };
    }

    return {
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: `Neither branch nor commit ${branch} found in repository ${owner}/${repo}`,
    };
  }

  // For paths, we need to check if the specific path exists
  // Get the content directly - this is more efficient than getting the whole tree
  const contentResult = await tryCatch(
    getContentCached({
      owner,
      repo,
      ref: branch,
      path,
    }),
  );

  if (contentResult.data) {
    return { ok: true, status: 200 };
  }

  // Check if it was a 404 error
  const error = contentResult.error as Partial<RequestError> | null;
  if (error?.status === 404) {
    return {
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: `Path ${path} not found in branch/commit ${branch}`,
    };
  }

  return {
    ok: false,
    error: "unexpected error",
    errorDetail: String(error),
  };
};
