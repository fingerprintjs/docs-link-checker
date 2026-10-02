import { checkLinkWithFetch } from "../fetch_check";
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

/** Sections whose index page (`/owner/repo/issues`) exists for every repository */
const SECTIONS_WITH_INDEX_PAGE = new Set(["issues", "discussions", "releases", "pulls"]);

type SectionCheckArgs = { url: URL; owner: string; repo: string; pathParts: string[] };

type SectionCheck = (args: SectionCheckArgs) => Promise<LinkCheckResult>;

/**
 * Checks by the first path segment after the repository (`/owner/repo/{section}/...`). A `Map`, so a segment like
 * `constructor` or `__proto__` from the URL never resolves an inherited object property.
 */
const SECTION_CHECKS = new Map<string, SectionCheck>([
  ["issues", ({ owner, repo, pathParts }) => checkGitHubIssueLink(owner, repo, pathParts)],
  [
    "discussions",
    ({ owner, repo, pathParts }) =>
      checkGitHubDiscussionLink(owner, repo, parseInt(pathParts[1] ?? "", 10)),
  ],
  // The blob and its hash: a heading, or a code line like `#L12`
  ["blob", ({ url, owner, repo, pathParts }) => checkGitHubBlobLink(url, owner, repo, pathParts)],
  ["tree", ({ owner, repo, pathParts }) => checkGitHubTreeLink(owner, repo, pathParts)],
  ["releases", ({ owner, repo, pathParts }) => checkGitHubReleaseLink(owner, repo, pathParts)],
  ["pull", ({ owner, repo, pathParts }) => checkGitHubPullRequestLink(owner, repo, pathParts)],
  ["commit", ({ owner, repo, pathParts }) => checkGitHubCommitLink(owner, repo, pathParts)],
]);

/** A user or an organization (`https://github.com/owner`) */
const checkOwnerLink = async (owner: string, url: string): Promise<LinkCheckResult> => {
  const result = await checkIfOwnerExists(owner);
  // Not an account: maybe one of GitHub's own pages missing from the reserved routes, check the page itself
  if (!result.ok && result.error === "broken link") {
    const page = await checkLinkWithFetch(url);
    if (page.ok) {
      return page;
    }
  }
  return result;
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
    return checkOwnerLink(owner, url);
  }

  const [section, ...sectionParts] = pathParts;

  // If pathParts is empty, it's a repository link, just check if it exists
  if (section === undefined) {
    return checkIfRepositoryExists(owner, repo);
  }

  // If nothings follows the section path segment, just check that the repository exists
  if (sectionParts.length === 0 && SECTIONS_WITH_INDEX_PAGE.has(section)) {
    return checkIfRepositoryExists(owner, repo);
  }

  // Wikis are not available through the API
  if (isGithubWikiLink(url)) {
    return checkLinkWithFetch(url);
  }

  const checkSection = SECTION_CHECKS.get(section);
  if (checkSection) {
    return checkSection({ url: githubUrl, owner, repo, pathParts });
  }

  return {
    ok: false,
    error: "unexpected error",
    status: 400,
    errorDetail: `Unknown link type: ${pathParts.join("/")}`,
  };
};
