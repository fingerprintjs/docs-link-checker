import type { LinkCheckResult } from "../../types";
import { tryCatch } from "../../utils/tryCatch";
import { getApiErrorResult, isNotFoundApiError } from "../gh_api_error";
import { getMyOctokit } from "../github_client";

/** `true` for a GraphQL "Could not resolve to a Repository/Discussion" (NOT_FOUND) error */
const isGraphqlNotFound = (error: unknown): boolean => {
  const { errors, message } = (error ?? {}) as { errors?: { type?: string }[]; message?: string };
  return (
    errors?.some((e) => e.type === "NOT_FOUND") === true ||
    /Could not resolve to a (Discussion|Repository)/.test(message ?? "")
  );
};

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
  // GraphQL answers a missing discussion or repository with a NOT_FOUND error in a 200 response
  if (isNotFoundApiError(error) || isGraphqlNotFound(error)) {
    return { ok: false, error: "broken link", status: 404, errorDetail: notFoundDetail };
  }
  return getApiErrorResult(error, notFoundDetail);
};
