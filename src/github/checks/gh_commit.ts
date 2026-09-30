import type { RequestError } from "@octokit/types";
import type { LinkCheckResult } from "../../types";
import { tryCatch } from "../../utils/tryCatch";
import { getMyOctokit } from "../github_client";

export const checkGitHubCommitLink = async (
  owner: string,
  repo: string,
  pathParts: string[]
): Promise<LinkCheckResult> => {
  const octokit = getMyOctokit();
  const [, commit] = pathParts;
  const { data, error } = await tryCatch(octokit.repos.getCommit({ owner, repo, ref: commit }));

  if (data) {
    return {
      ok: true,
      status: 200,
    };
  } else {
    if ((error as unknown as RequestError).status === 404) {
      return {
        ok: false,
        error: "broken link",
        status: 404,
        errorDetail: "Commit not found",
      };
    }
    return {
      ok: false,
      error: "unexpected error",
    };
  }
};
