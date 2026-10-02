import type { LinkCheckResult } from "../../types";
import { getApiErrorResult } from "../gh_api_error";
import { getRepoCached, getUserCached } from "../gh_cache";

/**
 * Check if a repository exists
 * @param owner - The owner of the repository
 * @param repo - The repository name
 * @returns - A LinkCheckResult object
 */
export const checkIfRepositoryExists = async (
  owner: string,
  repo: string,
): Promise<LinkCheckResult> => {
  try {
    await getRepoCached(owner, repo);
    return { ok: true, status: 200 };
  } catch (error) {
    // Only "not found" is a broken link: server errors (Octokit already retried them), rate limits and 401/403 say
    // nothing about the repository
    return getApiErrorResult(error, `Repository ${owner}/${repo} not found`);
  }
};

/**
 * Check if a GitHub user or organization exists (`https://github.com/owner`).
 * `GET /users/{owner}` works for both users and organizations.
 * @param owner - The user or organization name
 * @returns - A LinkCheckResult object
 */
export const checkIfOwnerExists = async (owner: string): Promise<LinkCheckResult> => {
  try {
    await getUserCached(owner);
    return { ok: true, status: 200 };
  } catch (error) {
    return getApiErrorResult(error, `User or organization ${owner} not found`);
  }
};
