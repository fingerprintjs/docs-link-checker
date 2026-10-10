import { checkLinkWithFetch } from "../check/fetch_check";
import type { LinkCheckResult } from "../types";
import { checkGitHubBlobLink, checkGitHubTreeLink } from "./checks/content";
import {
  checkGitHubCommitLink,
  checkGitHubDiscussionLink,
  checkGitHubIssueLink,
  checkGitHubPullRequestLink,
  checkGitHubReleaseLink,
  checkIfOwnerExists,
  checkIfRepositoryExists,
} from "./checks/simple";
import { getGithubPathSegments } from "./url";

/** Sections whose index page (`/owner/repo/issues`) exists for every repository */
const SECTIONS_WITH_INDEX_PAGE = new Set(["issues", "discussions", "releases", "pulls"]);

type SectionCheckArgs = {
  url: URL;
  owner: string;
  repo: string;
  pathParts: string[];
  signal: AbortSignal;
};

type SectionCheck = (args: SectionCheckArgs) => Promise<LinkCheckResult>;

/**
 * Checks by the first path segment after the repository (`/owner/repo/{section}/...`). A `Map`, so a segment like
 * `constructor` or `__proto__` from the URL never resolves an inherited object property.
 */
const SECTION_CHECKS = new Map<string, SectionCheck>([
  [
    "issues",
    ({ owner, repo, pathParts, signal }) => checkGitHubIssueLink(owner, repo, pathParts, signal),
  ],
  [
    "discussions",
    ({ owner, repo, pathParts, signal }) =>
      checkGitHubDiscussionLink(owner, repo, parseInt(pathParts[1] ?? "", 10), signal),
  ],
  // The blob and its hash: a heading, or a code line like `#L12`
  ["blob", checkGitHubBlobLink],
  [
    "tree",
    ({ owner, repo, pathParts, signal }) => checkGitHubTreeLink(owner, repo, pathParts, signal),
  ],
  [
    "releases",
    ({ owner, repo, pathParts, signal }) => checkGitHubReleaseLink(owner, repo, pathParts, signal),
  ],
  [
    "pull",
    ({ owner, repo, pathParts, signal }) =>
      checkGitHubPullRequestLink(owner, repo, pathParts, signal),
  ],
  [
    "commit",
    ({ owner, repo, pathParts, signal }) => checkGitHubCommitLink(owner, repo, pathParts, signal),
  ],
]);

/**
 * Use GitHub API (Octokit) to check if link is valid
 * Because using `fetch` run into rate limit issues really fast
 * @param url A GitHub link to a public repository, for example:
 * https://github.com/fingerprintjs/fingerprintjs-pro-angular/blob/main/README.md#documentation
 * Callers must route wiki links, GitHub's own pages and non-GitHub URLs elsewhere (see `getInitialCheckMethod`).
 * @param signal Aborts the API requests (the check timed out)
 *
 * @returns LinkCheckResult
 */
export const checkLinkWithGithubApi = async (
  url: string,
  signal: AbortSignal,
): Promise<LinkCheckResult> => {
  // Parse the GitHub URL. Segments are decoded (`%40` -> `@`), Octokit encodes them again in the API request.
  const githubUrl = new URL(url);
  const [owner, repo, ...pathParts] = getGithubPathSegments(githubUrl);

  // `https://github.com/` itself
  if (!owner) {
    return { ok: true, status: 200 };
  }

  // `https://github.com/owner` (with or without a trailing slash): a user or an organization, not a repository
  if (!repo) {
    const result = await checkIfOwnerExists(owner, signal);
    // Not an account: maybe one of GitHub's own pages missing from the reserved routes, check the page itself
    if (!result.ok && result.error === "broken link") {
      const page = await checkLinkWithFetch(url);
      if (page.ok) {
        return page;
      }
    }
    return result;
  }

  const [section, ...sectionParts] = pathParts;

  // If pathParts is empty, it's a repository link, just check if it exists
  if (section === undefined) {
    return checkIfRepositoryExists(owner, repo, signal);
  }

  // If nothings follows the section path segment, just check that the repository exists
  if (sectionParts.length === 0 && SECTIONS_WITH_INDEX_PAGE.has(section)) {
    return checkIfRepositoryExists(owner, repo, signal);
  }

  const checkSection = SECTION_CHECKS.get(section);
  if (checkSection) {
    return checkSection({ url: githubUrl, owner, repo, pathParts, signal });
  }

  return {
    ok: false,
    error: "unexpected error",
    status: 400,
    errorDetail: `Unknown link type: ${pathParts.join("/")}`,
  };
};
