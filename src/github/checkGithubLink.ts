import { myGithubClient } from "./githubClient";
import GithubSlugger from "github-slugger";
import { LinkCheckResult } from "../types";
import { checkLinkWithFetch } from "../link";

const octokit = myGithubClient;

/**
 * Check if a URL is a GitHub URL
 * @param url - The URL to check
 * @returns - True if the URL is a GitHub URL, false otherwise
 */
export const isGithubUrl = (url: string) => {
  const githubUrl = new URL(url);
  return githubUrl.hostname === "github.com";
};

/**
 * Check if a GitHub issue exists
 * @param owner - The owner of the repository
 * @param repo - The repository name
 * @param issueNumber - The issue number
 * @returns - A LinkCheckResult object
 */
export const checkGitHubIssueLink = async (owner: string, repo: string, pathParts: string[]): Promise<LinkCheckResult> => {
  const [, issueNumberPart] = pathParts;
  if (issueNumberPart === "new") {
    return { ok: true, status: 200 };
  }

  const issueNumber = parseInt(issueNumberPart, 10);
  try {
    await octokit.issues.get({
      owner,
      repo,
      issue_number: issueNumber,
    });

    // If we get here, the issue exists
    return { ok: true, status: 200 };
  } catch (error: any) {
    if (error.status === 404) {
      return {
        ok: false,
        error: "broken link",
        status: 404,
        errorDetail: `Issue #${issueNumber} not found in repository ${owner}/${repo}`,
      };
    }

    return {
      ok: false,
      error: "unexpected error",
      status: 429,
      errorDetail: "GitHub API rate limit exceeded",
    };
  }
};

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

  // Check if the file exists
  try {
    const { data: fileData } = await octokit.repos.getContent({
      owner,
      repo,
      ref: branch,
      path,
    });

    // If there's no hash, we're done - the file exists
    const hash = fullUrl.hash.slice(1).toLowerCase(); // Remove the # character, and make it lowercase
    if (!hash) {
      return { ok: true, status: 200 };
    }

    // For hash checking, we need to get the file content
    if (!("content" in fileData)) {
      return {
        ok: false,
        error: "hash not found",
        status: 200,
        errorDetail: "File has no content",
      };
    }

    const content = Buffer.from(fileData.content, "base64").toString();

    // Get all headings from the content
    const headingRegex = /^(#{1,6}\s+.*)$/gm;
    const headings = content.match(headingRegex);
    // Convert them to slugs
    const slugger = new GithubSlugger();
    const slugs = headings?.map((heading) => slugger.slug(heading.replace(/^#+\s*/, "").trim()));

    // Check if the hash is in the slugs
    if (slugs?.includes(hash)) {
      return { ok: true, status: 200 };
    } else {
      return {
        ok: false,
        error: "hash not found",
        status: 200,
        errorDetail: `No heading found matching hash: ${hash}`,
      };
    }
  } catch (error: any) {
    if (error.status === 429) {
      return {
        ok: false,
        error: "unexpected error",
        status: 429,
        errorDetail: "GitHub API rate limit exceeded",
      };
    }
    if (error.status === 404) {
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
};

/**
 * Check if a GitHub branch/tree exists
 * @param fullUrl - The full URL of the branch/tree
 * @param owner - The owner of the repository
 * @param repo - The repository name
 * @param pathParts - The path parts of the URL
 * @returns - A LinkCheckResult object
 */
export const checkGitHubTreeLink = async (
  fullUrl: URL,
  owner: string,
  repo: string,
  pathParts: string[]
): Promise<LinkCheckResult> => {
  const [, branch, ...restOfPath] = pathParts;
  const path = restOfPath.join("/");

  try {
    // Check if the branch and path exist
    const { data: treeData } = await octokit.git.getTree({
      owner,
      repo,
      tree_sha: branch,
      recursive: "1",
    });

    // If there's no path specified, we just check if the branch exists
    if (!path) {
      return { ok: true, status: 200 };
    }

    // Check if the path exists in the tree
    const pathExists = treeData.tree.some((item) => item.path === path);
    if (!pathExists) {
      return {
        ok: false,
        error: "broken link",
        status: 404,
        errorDetail: `Path ${path} not found in branch ${branch}`,
      };
    }

    return { ok: true, status: 200 };
  } catch (error: any) {
    if (error.status === 404) {
      return {
        ok: false,
        error: "broken link",
        status: 404,
        errorDetail: `Branch ${branch} not found in repository ${owner}/${repo}`,
      };
    }
    return {
      ok: false,
      error: "unexpected error",
      errorDetail: String(error),
    };
  }
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

/**
 * Check if a repository exists
 * @param owner - The owner of the repository
 * @param repo - The repository name
 * @returns - A LinkCheckResult object
 */
export const checkIfRepositoryExists = async (owner: string, repo: string): Promise<LinkCheckResult> => {
  try {
    await octokit.repos.get({ owner, repo });
    return { ok: true, status: 200 };
  } catch (error: any) {
    return { ok: false, error: "broken link", status: 404, errorDetail: `Repository ${owner}/${repo} not found` };
  }
};

/**
 * Check if a GitHub release exists
 * @param fullUrl - The full URL of the release
 * @param owner - The owner of the repository
 * @param repo - The repository name
 * @param pathParts - The path parts of the URL
 * @returns - A LinkCheckResult object
 */
export const checkGitHubReleaseLink = async (
  fullUrl: URL,
  owner: string,
  repo: string,
  pathParts: string[]
): Promise<LinkCheckResult> => {
  try {
    // If pathParts[1] is "latest", check if any release exists
    if (pathParts[1] === "latest") {
      const { data: releases } = await octokit.repos.listReleases({
        owner,
        repo,
        per_page: 1,
      });

      if (releases.length === 0) {
        return {
          ok: false,
          error: "broken link",
          status: 404,
          errorDetail: "No releases found in repository",
        };
      }

      return { ok: true, status: 200 };
    }

    // If pathParts[1] is "tag", check if the specific tag exists
    if (pathParts[1] === "tag") {
      const tag = pathParts[2];
      try {
        await octokit.repos.getReleaseByTag({
          owner,
          repo,
          tag,
        });
        return { ok: true, status: 200 };
      } catch (error: any) {
        if (error.status === 404) {
          return {
            ok: false,
            error: "broken link",
            status: 404,
            errorDetail: `Release tag ${tag} not found in repository ${owner}/${repo}`,
          };
        }
        throw error;
      }
    }

    // If pathParts[1] is a number, check if the specific release exists
    const releaseId = parseInt(pathParts[1], 10);
    if (!isNaN(releaseId)) {
      try {
        await octokit.repos.getRelease({
          owner,
          repo,
          release_id: releaseId,
        });
        return { ok: true, status: 200 };
      } catch (error: any) {
        if (error.status === 404) {
          return {
            ok: false,
            error: "broken link",
            status: 404,
            errorDetail: `Release #${releaseId} not found in repository ${owner}/${repo}`,
          };
        }
        throw error;
      }
    }

    return {
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "Invalid release URL format",
    };
  } catch (error: any) {
    return {
      ok: false,
      error: "unexpected error",
      status: 500,
      errorDetail: String(error),
    };
  }
};

/**
 * Check if a GitHub pull request exists
 * @param fullUrl - The full URL of the pull request
 * @param owner - The owner of the repository
 * @param repo - The repository name
 * @param pathParts - The path parts of the URL
 * @returns - A LinkCheckResult object
 */
export const checkGitHubPullRequestLink = async (
  fullUrl: URL,
  owner: string,
  repo: string,
  pathParts: string[]
): Promise<LinkCheckResult> => {
  try {
    const prNumber = parseInt(pathParts[1], 10);
    if (isNaN(prNumber)) {
      return {
        ok: false,
        error: "broken link",
        status: 404,
        errorDetail: "Invalid pull request number",
      };
    }

    await octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    return { ok: true, status: 200 };
  } catch (error: any) {
    if (error.status === 404) {
      return {
        ok: false,
        error: "broken link",
        status: 404,
        errorDetail: `Pull request #${pathParts[1]} not found in repository ${owner}/${repo}`,
      };
    }
    if (error.status === 429) {
      return {
        ok: false,
        error: "unexpected error",
        status: 429,
        errorDetail: "GitHub API rate limit exceeded",
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

/**
 * Use GitHub API (Octokit) to check if link is valid
 * Because using `fetch` run into rate limit issues really fast
 * @param url A GitHub link to a public repository, for example:
 * https://github.com/fingerprintjs/fingerprintjs-pro-angular/blob/main/README.md#documentation
 *
 * @returns LinkCheckResult
 */
export const checkLinkWithGithubApi = async (url: string): Promise<LinkCheckResult> => {
  if (!isGithubUrl(url)) {
    throw new Error("Not a GitHub URL");
  }

  // Parse the GitHub URL
  const githubUrl = new URL(url);
  const [owner, repo, ...pathParts] = githubUrl.pathname.split("/").filter(Boolean);

  // If pathParts is empty, it's a repository link, just check if it exists
  if (pathParts.length === 0) {
    return checkIfRepositoryExists(owner, repo);
  }

  // If nothings follows the section path segment, just check that the repository exists
  if (pathParts.length === 1 && ["issues", "discussions", "releases", "pulls"].includes(pathParts[0])) {
    return checkIfRepositoryExists(owner, repo);
  }

  // If issue, check if it exists
  if (pathParts[0] === "issues") {
    return checkGitHubIssueLink(owner, repo, pathParts);
  }

  // If discussion, check if it exists
  if (pathParts[0] === "discussions") {
    return checkGitHubDiscussionLink(owner, repo, parseInt(pathParts[1], 10));
  }

  // If blob, check if it exists
  if (pathParts[0] === "blob") {
    return checkGitHubBlobLink(githubUrl, owner, repo, pathParts);
  }

  // If branch or folder, check if it exists
  if (pathParts[0] === "tree") {
    return checkGitHubTreeLink(githubUrl, owner, repo, pathParts);
  }

  // If release, check if it exists
  if (pathParts[0] === "releases") {
    return checkGitHubReleaseLink(githubUrl, owner, repo, pathParts);
  }

  // If pull request, check if it exists
  if (pathParts[0] === "pull") {
    return checkGitHubPullRequestLink(githubUrl, owner, repo, pathParts);
  }

  // If wiki, check if it exists
  if (pathParts[0] === "wiki") {
    return checkLinkWithFetch(url);
  }

  return {
    ok: false,
    error: "unexpected error",
    status: 400,
    errorDetail: `Unknown link type: ${pathParts.join("/")}`,
  };
};
