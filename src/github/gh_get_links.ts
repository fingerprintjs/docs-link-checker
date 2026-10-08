/**
 * Links of the README files of a GitHub organization: lists the public repositories, finds README files in their
 * default branch, downloads them and checks their links.
 */
import { Effect } from "effect";
import type { RunServices } from "../app";
import { HttpStatusError, OrgListError } from "../errors";
import { fetchLimited } from "../http";
import { checkLinks } from "../link";
import { extractMarkdownLinks } from "../markdown";
import { Metrics } from "../metrics";
import { filterOutIrrelevantLinks } from "../page";
import type { Link, LinkWithResult } from "../types";
import { processAll, sampleItems } from "../utils";
import { GitHub, type GitHubError } from "./github_client";

/** Deprecated integrations: READMEs are unmaintained and would only add noise to org-wide checks. */
const GITHUB_ORG_EXCLUDED_REPOS = new Set(["fingerprint-pro-segment-source-function"]);

export type MdFile = { readonly sourcePath: string; readonly downloadUrl: string };

const findReadmeFilesInRepo = (
  owner: string,
  repo: string,
): Effect.Effect<MdFile[], GitHubError, GitHub> =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    // The default branch is cached, links to the repository reuse it
    const { default_branch: defaultBranch } = yield* github.getRepo(owner, repo);
    const entries = yield* github.getTreeEntries(owner, repo, defaultBranch);
    return entries.flatMap(({ type, path }) =>
      type === "blob" && path?.toLowerCase().endsWith("readme.md")
        ? [
            {
              sourcePath: `https://github.com/${owner}/${repo}/blob/${defaultBranch}/${path}`,
              downloadUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/${path}`,
            },
          ]
        : [],
    );
  });

/**
 * Lists README files in all public, non-archived repositories of the organization, sampled by `sampleRate`.
 * A repository whose tree cannot be read is skipped with a warning, the repository list failing is an error.
 */
export const getReadmesFromOrg = Effect.fn("github.getReadmesFromOrg")(function* (
  org: string,
  sampleRate: number,
) {
  const github = yield* GitHub;
  const orgRepos = yield* github
    .listOrgRepos(org)
    .pipe(Effect.mapError((cause) => new OrgListError({ org, cause })));
  const repos = orgRepos.filter(
    (repo) => !repo.archived && !GITHUB_ORG_EXCLUDED_REPOS.has(repo.name),
  );
  yield* Effect.logInfo(`\nFound ${repos.length} public repositories in ${org} organization.`);

  const { results, errors } = yield* processAll({
    items: repos,
    process: (repo) => findReadmeFilesInRepo(repo.owner.login, repo.name),
  });
  if (errors.length > 0) {
    // Already logged by processAll, make it clear that the README list is incomplete
    yield* Effect.logWarning(
      `Could not list README files in ${errors.length} repositories, their links will not be checked.`,
    );
  }
  const readmes = results.flat();
  yield* Effect.logInfo(
    `\nFound ${readmes.length} public Readmes files in ${repos.length} repositories of ${org} organization.`,
  );
  return yield* sampleItems({
    items: readmes,
    key: (readme) => readme.sourcePath,
    rate: sampleRate,
    label: "README files",
  });
});

/** The `https://github.com/owner/repo/blob/<ref>` prefix of a README's blob URL, to resolve repo-relative links */
const extractGitHubRepoUrl = (url: string): string | undefined =>
  url.match(/(https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/[^/]+)/)?.[1];

/**
 * Resolves an href found in a README against the blob URL it was downloaded from:
 * - A root-relative path (`/docs/a.md`) resolves against the repository, like GitHub renders it.
 * - A `#hash` resolves against the page.
 * - Anything else resolves against the page URL, absolute URLs are returned unchanged.
 */
export const resolveReadmeHref = (href: string, page: string): string => {
  if (URL.canParse(href)) return href;
  if (href.startsWith("#")) return `${page}${href}`;
  const repoUrl = extractGitHubRepoUrl(page);
  if (href.startsWith("/") && repoUrl) return `${repoUrl}${href}`;
  return new URL(href, page).toString();
};

/** Downloads README files (limited per host) and extracts their links. Files that fail are logged and skipped. */
export const getReadmeLinks = Effect.fn("github.getReadmeLinks")(function* (
  files: ReadonlyArray<MdFile>,
) {
  yield* Effect.logInfo(`\nRetrieving links from ${files.length} files...`);
  const { results } = yield* processAll({
    items: files,
    process: (file) =>
      Effect.gen(function* () {
        const response = yield* fetchLimited(file.downloadUrl, {}, (res) =>
          res.ok ? res.text() : Promise.resolve(""),
        );
        if (response.status < 200 || response.status >= 300) {
          return yield* new HttpStatusError({
            url: file.downloadUrl,
            status: response.status,
            message: `Could not download ${file.downloadUrl}, status: ${response.status}`,
          });
        }
        return extractMarkdownLinks(response.data).map(({ href, text }): Link => ({
          page: file.sourcePath,
          href: resolveReadmeHref(href, file.sourcePath),
          text,
        }));
      }),
  });

  const links = results.flat();
  yield* Effect.logInfo(`Extracted ${links.length} links from ${files.length} files.`);
  return links;
});

/** Report name of an organization (`fingerprintjs` -> `fingerprintjs-github-readmes.html`) */
export const getGithubOrgSiteName = (org: string) => `${org} GitHub readmes`;

/** Checks links in README files of all public repositories of a GitHub organization */
export const checkReadmesInGithubOrg = Effect.fn("github.checkReadmesInGithubOrg")(function* (
  org: string,
  options: { readonly sampleRate: number },
): Effect.fn.Return<LinkWithResult[], OrgListError, RunServices> {
  const metrics = yield* Metrics;
  const readmes = yield* metrics.timePhase(
    "List README files",
    getReadmesFromOrg(org, options.sampleRate),
  );
  const links = yield* metrics.timePhase("Extract links", getReadmeLinks(readmes));
  return yield* checkLinks({ links: filterOutIrrelevantLinks(links), fetchConcurrencyLimit: 20 });
});
