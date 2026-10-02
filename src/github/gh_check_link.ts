import { checkLinkWithFetch } from "../link";
import type { LinkCheckResult } from "../types";
import { checkGitHubBlobLink } from "./checks/gh_blob";
import { checkGitHubCommitLink } from "./checks/gh_commit";
import { checkGitHubDiscussionLink } from "./checks/gh_discussion";
import { checkGitHubIssueLink } from "./checks/gh_issue";
import { checkGitHubPullRequestLink } from "./checks/gh_pr";
import { checkGitHubReleaseLink } from "./checks/gh_release";
import { checkIfOwnerExists, checkIfRepositoryExists } from "./checks/gh_repo";
import { checkGitHubTreeLink } from "./checks/gh_tree";
import {
  getGithubPathSegments,
  isGithubCodeLineLink,
  isGithubReservedRoute,
  isGithubUrl,
  isGithubWikiLink,
} from "./gh_url";

export { isGithubCodeLineLink, isGithubUrl, isGithubWikiLink };

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

  // Parse the GitHub URL. Segments are decoded (`%40` -> `@`), Octokit encodes them again in the API request.
  const githubUrl = new URL(url);
  const [owner, repo, ...pathParts] = getGithubPathSegments(githubUrl);

  // `https://github.com/` itself
  if (!owner) {
    return { ok: true, status: 200 };
  }

  // GitHub's own pages (`/features`, `/topics/x`...), not an account: check the page itself
  if (isGithubReservedRoute(url)) {
    return checkLinkWithFetch(url);
  }

  // `https://github.com/owner` (with or without a trailing slash): a user or an organization, not a repository
  if (!repo) {
    const result = await checkIfOwnerExists(owner);
    // Not an account: maybe one of GitHub's own pages missing from the reserved routes, check the page itself
    if (!result.ok && result.error === "broken link") {
      const page = await checkLinkWithFetch(url);
      if (page.ok) {
        return page;
      }
    }
    return result;
  }

  // If pathParts is empty, it's a repository link, just check if it exists
  if (pathParts.length === 0) {
    return checkIfRepositoryExists(owner, repo);
  }

  // If nothings follows the section path segment, just check that the repository exists
  if (
    pathParts.length === 1 &&
    ["issues", "discussions", "releases", "pulls"].includes(pathParts[0])
  ) {
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

  // If blob, check if it exists (and its hash: a heading, or a code line like `#L12`)
  if (pathParts[0] === "blob") {
    return checkGitHubBlobLink(githubUrl, owner, repo, pathParts);
  }

  // If branch or folder, check if it exists
  if (pathParts[0] === "tree") {
    return checkGitHubTreeLink(owner, repo, pathParts);
  }

  // If release, check if it exists
  if (pathParts[0] === "releases") {
    return checkGitHubReleaseLink(owner, repo, pathParts);
  }

  // If pull request, check if it exists
  if (pathParts[0] === "pull") {
    return checkGitHubPullRequestLink(owner, repo, pathParts);
  }

  // If wiki, check if it exists
  if (isGithubWikiLink(url)) {
    return checkLinkWithFetch(url);
  }

  // If commit, check if it exists
  if (pathParts[0] === "commit") {
    return checkGitHubCommitLink(owner, repo, pathParts);
  }

  return {
    ok: false,
    error: "unexpected error",
    status: 400,
    errorDetail: `Unknown link type: ${pathParts.join("/")}`,
  };
};
