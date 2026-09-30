import { LinkCheckResult } from "../../types";
import { getMyOctokit } from "../github_client";

/**
 * Check if a repository exists
 * @param owner - The owner of the repository
 * @param repo - The repository name
 * @returns - A LinkCheckResult object
 */
export const checkIfRepositoryExists = async (
  owner: string,
  repo: string
): Promise<LinkCheckResult> => {
  const octokit = getMyOctokit();
  try {
    await octokit.repos.get({ owner, repo });
    return { ok: true, status: 200 };
  } catch (error: any) {
    return {
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: `Repository ${owner}/${repo} not found`,
    };
  }
};
