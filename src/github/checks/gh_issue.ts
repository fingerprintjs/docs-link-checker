import { LinkCheckResult } from "../../types";
import { getMyOctokit } from "../github_client";

const octokit = getMyOctokit();

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
  pathParts: string[]
): Promise<LinkCheckResult> => {
  const [, issueNumberPart] = pathParts;
  if (issueNumberPart === "new") {
    return { ok: true, status: 200 };
  }

  const issueNumber = parseInt(issueNumberPart, 10);
  try {
    await octokit.issues.get({
      owner,
      repo,
      issue_number: issueNumber,
    });

    // If we get here, the issue exists
    return { ok: true, status: 200 };
  } catch (error: any) {
    if (error.status === 404) {
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
      status: error.status,
      errorDetail: error.message,
    };
  }
};
