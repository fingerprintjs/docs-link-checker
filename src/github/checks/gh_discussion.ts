import type { RequestError } from "@octokit/types";
import type { LinkCheckResult } from "../../types";
import { tryCatch } from "../../utils/tryCatch";
import { getMyOctokit } from "../github_client";

/**
 * Check if a GitHub discussion exists
 * @param owner - The owner of the repository
 * @param repo - The repository name
 * @param discussionNumber - The discussion number
 * @returns - A LinkCheckResult object
 */
export const checkGitHubDiscussionLink = async (
  owner: string,
  repo: string,
  discussionNumber: number,
): Promise<LinkCheckResult> => {
  const octokit = getMyOctokit();
  const { data, error } = await tryCatch(
    octokit.graphql(`
      query {
        repository(owner: "${owner}", name: "${repo}") {
          discussion(number: ${discussionNumber}) {
            id
          }
        }
      }
    `),
  );

  if (data) {
    return { ok: true, status: 200 };
  }

  if (
    (error as unknown as RequestError).status === 404 ||
    error?.message?.includes("Could not resolve to a Discussion")
  ) {
    return {
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: `Discussion #${discussionNumber} not found in repository ${owner}/${repo}`,
    };
  }

  return {
    ok: false,
    error: "unexpected error",
    status: 500,
    errorDetail: String(error),
  };
};
