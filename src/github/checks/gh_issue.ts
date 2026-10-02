import type { LinkCheckResult } from "../../types";
import { tryCatch } from "../../utils/tryCatch";
import { getApiErrorResult } from "../gh_api_error";
import { getMyOctokit } from "../github_client";

/**
 * Check if a GitHub issue exists
 * @param owner - The owner of the repository
 * @param repo - The repository name
 * @param issueNumber - The issue number
 * @returns - A LinkCheckResult object
 */

export const checkGitHubIssueLink = async (
  owner: string,
  repo: string,
  pathParts: string[],
): Promise<LinkCheckResult> => {
  const octokit = getMyOctokit();
  const [, issueNumberPart = ""] = pathParts;
  if (issueNumberPart === "new") {
    return { ok: true, status: 200 };
  }

  const issueNumber = parseInt(issueNumberPart, 10);
  if (Number.isNaN(issueNumber)) {
    return {
      ok: false,
      error: "broken link",
      errorDetail: `Invalid issue number format: ${issueNumberPart}`,
    };
  }

  const { error } = await tryCatch(
    octokit.issues.get({
      owner,
      repo,
      issue_number: issueNumber,
    }),
  );

  if (error) {
    // 410: the issue was deleted
    return getApiErrorResult(
      error,
      `Issue #${issueNumber} not found in repository ${owner}/${repo}`,
    );
  }

  return { ok: true, status: 200 };
};
