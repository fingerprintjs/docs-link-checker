import { LinkCheckResult } from "../../types";
import { getMyOctokit } from "../github_client";
import GithubSlugger from "github-slugger";
import { tryCatch } from "../../utils/tryCatch";
import { RequestError } from "@octokit/types";

const octokit = getMyOctokit();

/**
 * Check if a GitHub blob exists
 * @param fullUrl - The full URL of the blob
 * @param owner - The owner of the repository
 * @param repo - The repository name
 * @param pathParts - The path parts of the URL
 * @returns - A LinkCheckResult object
 */
export const checkGitHubBlobLink = async (
  fullUrl: URL,
  owner: string,
  repo: string,
  pathParts: string[]
): Promise<LinkCheckResult> => {
  const [, branch, ...restOfPath] = pathParts;
  const path = restOfPath.join("/");
  const hash = fullUrl.hash.slice(1).toLowerCase(); // Remove the # character, and make it lowercase

  const { data: response, error } = await tryCatch(
    octokit.repos.getContent({
      owner,
      repo,
      ref: branch,
      path,
    })
  );

  if (error) {
    if ((error as unknown as RequestError).status === 404) {
      return {
        ok: false,
        error: "broken link",
        status: 404,
        errorDetail: "File not found in repository",
      };
    }
    return {
      ok: false,
      error: "unexpected error",
      errorDetail: String(error),
    };
  }

  // If there's no hash, we're done - the file exists
  if (!hash) {
    return { ok: true, status: 200 };
  }

  // For hash checking, we need to get the file content
  const fileData = response.data;
  if (!("content" in fileData)) {
    return {
      ok: false,
      error: "hash not found",
      status: 200,
      errorDetail: "File has no content",
    };
  }

  const content = Buffer.from(fileData.content as string, "base64").toString();

  // Get all headings from the content
  const headingRegex = /^(#{1,6}\s+.*)$/gm;
  const headings = content.match(headingRegex);
  // Convert them to slugs
  const slugger = new GithubSlugger();
  const slugs = headings?.map((heading) => slugger.slug(heading.replace(/^#+\s*/, "").trim()));

  // Check if the hash is in the slugs
  if (slugs?.includes(hash)) {
    return { ok: true, status: 200 };
  }

  return {
    ok: false,
    error: "hash not found",
    status: 200,
    errorDetail: `No heading found matching hash: ${hash}`,
  };
};
