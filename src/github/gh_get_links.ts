import { Data, Effect } from "effect";
import { fetchWithHostLimit, readText } from "../http";
import { checkLinks } from "../link";
import { extractMarkdownLinks } from "../markdown";
import { filterOutIrrelevantLinks } from "../page";
import { timePhase } from "../run";
import type { Link } from "../types";
import { processInParallel, sampleItems } from "../utils";
import { getErrorMessage } from "../utils/errors";
import { getRepoCached } from "./gh_api";
import { githubRequest } from "./github_client";

/** Deprecated integrations: READMEs are unmaintained and would only add noise to org-wide checks. */
const GITHUB_ORG_EXCLUDED_REPOS = new Set(["fingerprint-pro-segment-source-function"]);

export interface MdFile {
  sourcePath: string;
  downloadUrl: string;
}

/** The public repositories of an organization could not be listed */
export class ListOrgReposError extends Data.TaggedError("ListOrgReposError")<{
  readonly org: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `Failed to list repositories of GitHub organization ${this.org}: ${getErrorMessage(this.cause)}`;
  }
}

/** A README file answered with a status other than 2xx */
export class ReadmeDownloadError extends Data.TaggedError("ReadmeDownloadError")<{
  readonly url: string;
  readonly status: number;
}> {
  override get message() {
    return `Could not download ${this.url}, status: ${this.status}`;
  }
}

const getOrgRepos = (orgName: string) =>
  githubRequest((octokit) =>
    octokit.paginate(octokit.repos.listForOrg, {
      org: orgName,
      type: "public",
      per_page: 100,
    }),
  ).pipe(
    Effect.map((repos) =>
      repos
        .filter((repo) => repo.archived === false && !GITHUB_ORG_EXCLUDED_REPOS.has(repo.name))
        .map((repo) => ({
          full_name: repo.full_name,
          owner: { login: repo.owner.login },
          name: repo.name,
        })),
    ),
  );

const findReadmeFilesInRepo = (owner: string, repo: string) =>
  Effect.gen(function* () {
    // Get the default branch (cached, links to the repository reuse the response)
    const { data: repoData } = yield* getRepoCached(owner, repo);
    const defaultBranch = repoData.default_branch;

    // Get the complete tree with all files
    const { data: treeData } = yield* githubRequest((octokit) =>
      octokit.git.getTree({ owner, repo, tree_sha: defaultBranch, recursive: "1" }),
    );

    // Filter only markdown files
    return treeData.tree
      .filter((item) => item.type === "blob" && item.path.toLowerCase().endsWith("readme.md"))
      .map((item): MdFile => ({
        sourcePath: `https://github.com/${owner}/${repo}/blob/${defaultBranch}/${item.path}`,
        downloadUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/${item.path}`,
      }));
  });

/**
 * Lists README files in all public, non-archived repositories of the organization
 * (sampled according to `sampleRate`, default `LINK_CHECK_SAMPLE_RATE`).
 * Fails with `ListOrgReposError` if the repositories cannot be listed.
 */
export const getReadmesFromOrg = (orgName: string, sampleRate?: number) =>
  Effect.gen(function* () {
    const repos = yield* getOrgRepos(orgName).pipe(
      Effect.mapError((error) => new ListOrgReposError({ org: orgName, cause: error })),
    );
    console.log(`\nFound ${repos.length} public repositories in ${orgName} organization.`);

    const { results, errors } = yield* processInParallel({
      items: repos,
      processFn: (repo) => findReadmeFilesInRepo(repo.owner.login, repo.name),
    });
    if (errors.length > 0) {
      // Already logged by processInParallel, make it clear that the README list is incomplete
      console.warn(
        `Could not list README files in ${errors.length} repositories, their links will not be checked.`,
      );
    }
    const readmes = results.flat();
    console.log(
      `\nFound ${readmes.length} public Readmes files in ${repos.length} repositories of ${orgName} organization.`,
    );
    return sampleItems({
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

/** Downloads README files (limited per host) and extracts their links */
export const getReadmeLinks = (files: MdFile[]) =>
  Effect.gen(function* () {
    console.log(`\nRetrieving links from ${files.length} files...`);
    const { results } = yield* processInParallel({
      items: files,
      processFn: (file) =>
        Effect.gen(function* () {
          const response = yield* fetchWithHostLimit(file.downloadUrl, {}, (res) =>
            res.ok ? readText(res) : Effect.succeed(""),
          );
          if (response.status < 200 || response.status >= 300) {
            return yield* new ReadmeDownloadError({
              url: file.downloadUrl,
              status: response.status,
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
    console.log(`Extracted ${links.length} links from ${files.length} files.`);
    return links;
  });

/** Report name of an organization (`fingerprintjs` -> `fingerprintjs-github-readmes.html`) */
export const getGithubOrgSiteName = (org: string) => `${org} GitHub readmes`;

/**
 * Checks links in README files of all public repositories of a GitHub organization.
 * Must run inside the run of a CLI command: GitHub API responses are cached per run.
 */
export const checkReadmesInGithubOrg = (
  org: string,
  { sampleRate }: { sampleRate?: number } = {},
) =>
  Effect.gen(function* () {
    const fingerprintPublicReadmes = yield* timePhase(
      "List README files",
      getReadmesFromOrg(org, sampleRate),
    );
    const links = yield* timePhase("Extract links", getReadmeLinks(fingerprintPublicReadmes));
    return yield* checkLinks({
      links: filterOutIrrelevantLinks(links),
      fetchConcurrencyLimit: 20,
    });
  });
