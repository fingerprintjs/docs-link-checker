import type { LinkCheckResult } from "../../types";
import { tryCatch } from "../../utils/tryCatch";
import { getApiErrorResult, getApiErrorStatus, isNotFoundApiError } from "../gh_api_error";
import { getRefPathContent } from "../gh_ref";
import { getMyOctokit } from "../github_client";

/**
 * `true` if a failed `GET /git/commits/{sha}` proves the ref is not a commit: not found, or 422 (not a valid SHA, like
 * a branch name)
 */
const isNotACommitError = (error: unknown) =>
  isNotFoundApiError(error) || getApiErrorStatus(error) === 422;

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
  const [, branch = "", ...restOfPath] = pathParts;
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

    // Only "not found" answers prove the link is broken. Server errors, rate limits (Octokit already retried them) and
    // 401/403 say nothing about the branch or commit.
    if (!isNotFoundApiError(branchResult.error)) {
      return getApiErrorResult(branchResult.error, "");
    }
    if (!isNotACommitError(commitResult.error)) {
      return getApiErrorResult(commitResult.error, "");
    }

    return {
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: `Neither branch nor commit ${branch} found in repository ${owner}/${repo}`,
    };
  }

  // For paths, check the specific path (the ref can contain slashes: `tree/feature/x/src`, see `getRefPathContent`)
  const content = await getRefPathContent(owner, repo, pathParts.slice(1), { requirePath: false });
  if (content.found) {
    return { ok: true, status: 200 };
  }
  return getApiErrorResult(content.error, `Path ${path} not found in branch/commit ${branch}`);
};
