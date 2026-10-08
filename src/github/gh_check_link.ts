/**
 * Checks a GitHub URL with the GitHub API (links through `fetch` hit the rate limit quickly).
 * Callers route wiki links, GitHub's own pages and non-GitHub URLs elsewhere (see `getInitialCheckMethod` in `link.ts`).
 */
import { Effect } from "effect";
import type { GitHubTimeout } from "../errors";
import { checkLinkWithFetch } from "../fetch_check";
import type { LinkCheckResult } from "../types";
import { checkGitHubBlobLink, checkGitHubTreeLink } from "./checks/gh_content";
import {
  checkGitHubCommitLink,
  checkGitHubDiscussionLink,
  checkGitHubIssueLink,
  checkGitHubPullRequestLink,
  checkGitHubReleaseLink,
  checkIfOwnerExists,
  checkIfRepositoryExists,
} from "./checks/gh_simple";
import { getGithubPathSegments } from "./gh_url";
import type { GitHub } from "./github_client";

/** Sections whose index page (`/owner/repo/issues`) exists for every repository */
const SECTIONS_WITH_INDEX_PAGE = new Set(["issues", "discussions", "releases", "pulls"]);

type SectionCheckArgs = { url: URL; owner: string; repo: string; pathParts: string[] };

type SectionCheck = (
  args: SectionCheckArgs,
) => Effect.Effect<LinkCheckResult, GitHubTimeout, GitHub>;

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

/**
 * Use the GitHub API to check if a link is valid, because `fetch` runs into the rate limit really fast.
 * @param url A GitHub link to a public repository, for example:
 * https://github.com/fingerprintjs/fingerprintjs-pro-angular/blob/main/README.md#documentation
 */
export const checkLinkWithGithubApi = Effect.fn("github.checkLinkWithGithubApi")(function* (
  url: string,
) {
  // Segments are decoded (`%40` -> `@`), the API requests encode them again.
  const githubUrl = new URL(url);
  const [owner, repo, ...pathParts] = getGithubPathSegments(githubUrl);

  // `https://github.com/` itself
  if (!owner) {
    return { ok: true, status: 200 } satisfies LinkCheckResult;
  }

  // `https://github.com/owner` (with or without a trailing slash): a user or an organization, not a repository
  if (!repo) {
    const result = yield* checkIfOwnerExists(owner);
    // Not an account: maybe one of GitHub's own pages missing from the reserved routes, check the page itself
    if (!result.ok && result.error === "broken link") {
      const page = yield* checkLinkWithFetch(url);
      if (page.ok) {
        return page;
      }
    }
    return result;
  }

  const [section, ...sectionParts] = pathParts;

  // If pathParts is empty, it's a repository link, just check if it exists
  if (section === undefined) {
    return yield* checkIfRepositoryExists(owner, repo);
  }

  // If nothings follows the section path segment, just check that the repository exists
  if (sectionParts.length === 0 && SECTIONS_WITH_INDEX_PAGE.has(section)) {
    return yield* checkIfRepositoryExists(owner, repo);
  }

  const checkSection = SECTION_CHECKS.get(section);
  if (checkSection) {
    return yield* checkSection({ url: githubUrl, owner, repo, pathParts });
  }

  return {
    ok: false,
    error: "unexpected error",
    status: 400,
    errorDetail: `Unknown link type: ${pathParts.join("/")}`,
  } satisfies LinkCheckResult;
});
