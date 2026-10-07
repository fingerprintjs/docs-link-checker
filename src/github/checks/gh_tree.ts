import type { LinkCheckResult } from "../../types";
import { getApiErrorResult } from "../gh_api_error";
import { getRefPathContent } from "../gh_ref";

/**
 * Check if a GitHub branch/tag/commit (`tree/<ref>`) or a path in it (`tree/<ref>/<path>`) exists. The contents API
 * accepts a branch, tag or commit SHA as ref and an empty path (repository root).
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
  // The ref can contain slashes: `tree/feature/x/src` (see `getRefPathContent`)
  const [, ref = "", ...restOfPath] = pathParts;
  const path = restOfPath.join("/");
  const content = await getRefPathContent(owner, repo, pathParts.slice(1), { requirePath: false });
  if (content.found) {
    return { ok: true, status: 200 };
  }
  return getApiErrorResult(
    content.error,
    path
      ? `Path ${path} not found in branch/commit ${ref}`
      : `Neither branch nor commit ${ref} found in repository ${owner}/${repo}`,
  );
};
