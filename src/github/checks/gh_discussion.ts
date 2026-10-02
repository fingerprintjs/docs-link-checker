import type { LinkCheckResult } from "../../types";
import { tryCatch } from "../../utils/tryCatch";
import { getApiErrorResult, isNotFoundApiError } from "../gh_api_error";
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

  const notFoundDetail = `Discussion #${discussionNumber} not found in repository ${owner}/${repo}`;
  // GraphQL answers a missing discussion (or repository) with an error in a 200 response
  if (isNotFoundApiError(error) || error?.message?.includes("Could not resolve to a Discussion")) {
    return { ok: false, error: "broken link", status: 404, errorDetail: notFoundDetail };
  }
  return getApiErrorResult(error, notFoundDetail);
};
