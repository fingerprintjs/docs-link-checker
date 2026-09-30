import { LinkCheckResult } from "../../types";
import { getRepoCached } from "../gh_cache";

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
  try {
    await getRepoCached(owner, repo);
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
