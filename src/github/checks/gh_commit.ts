import type { LinkCheckResult } from "../../types";
import { tryCatch } from "../../utils/tryCatch";
import { getApiErrorResult } from "../gh_api_error";
import { getMyOctokit } from "../github_client";

export const checkGitHubCommitLink = async (
  owner: string,
  repo: string,
  pathParts: string[],
): Promise<LinkCheckResult> => {
  const octokit = getMyOctokit();
  const [, commit] = pathParts;
  const { data, error } = await tryCatch(octokit.repos.getCommit({ owner, repo, ref: commit }));

  if (data) {
    return { ok: true, status: 200 };
  }
  return getApiErrorResult(error, "Commit not found");
};
