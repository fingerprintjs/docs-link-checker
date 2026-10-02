import type { LinkCheckResult } from "../../types";
import { getErrorStatus } from "../../utils/errors";
import { tryCatch } from "../../utils/tryCatch";
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
    const status = getErrorStatus(error);
    if (status === 404) {
      return {
        ok: false,
        error: "broken link",
        status: 404,
        errorDetail: `Issue #${issueNumber} not found in repository ${owner}/${repo}`,
      };
    }

    return {
      ok: false,
      error: "unexpected error",
      status: status,
      errorDetail: String(error),
    };
  }

  return { ok: true, status: 200 };
};
