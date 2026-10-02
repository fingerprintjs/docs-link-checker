import type { LinkCheckResult } from "../../types";
import { getRepoCached, getUserCached, isTransientApiError } from "../gh_cache";

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
    // Server errors (Octokit already retried them) and rate limits say nothing about the repository
    if (isTransientApiError(error)) {
      return {
        ok: false,
        error: "unexpected error",
        status: (error as { status?: number }).status,
        errorDetail: String(error),
      };
    }
    return {
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: `Repository ${owner}/${repo} not found`,
    };
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
    if ((error as { status?: number } | undefined)?.status === 404) {
      return {
        ok: false,
        error: "broken link",
        status: 404,
        errorDetail: `User or organization ${owner} not found`,
      };
    }
    return { ok: false, error: "unexpected error", errorDetail: String(error) };
  }
};
