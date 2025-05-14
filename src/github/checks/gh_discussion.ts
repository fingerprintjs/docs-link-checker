import { LinkCheckResult } from "../../types";
import { getMyOctokit } from "../github_client";

const octokit = getMyOctokit();

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
  discussionNumber: number
): Promise<LinkCheckResult> => {
  try {
    // Using the GraphQL API to check if a discussion exists
    const response = await octokit.graphql(`
        query {
          repository(owner: "${owner}", name: "${repo}") {
            discussion(number: ${discussionNumber}) {
              id
            }
          }
        }
      `);

    // If we get here, the discussion exists
    return { ok: true, status: 200 };
  } catch (error: any) {
    if (error.status === 404 || error.message?.includes("Could not resolve to a Discussion")) {
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
  }
};
