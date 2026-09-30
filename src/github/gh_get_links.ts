import { fetchWithHostLimit } from "../http";
import { checkLinks } from "../link";
import { extractLinksFromMarkdown } from "../markdown";
import { filterOutIrrelevantLinks } from "../page";
import { getJSONReport, saveReport } from "../report/report";
import { withRun } from "../run";
import { timePhase } from "../run_context";
import type { Link } from "../types";
import { formatPoolErrors, parallelProcess, sampleItems } from "../utils";
import { getRepoCached } from "./gh_cache";
import { checkGitHubRateLimit, getMyOctokit } from "./github_client";

export interface MdFile {
  sourcePath: string;
  downloadUrl: string;
}

async function getOrgRepos(orgName: string) {
  const octokit = getMyOctokit();
  const repos = await octokit.paginate(octokit.repos.listForOrg, {
    org: orgName,
    type: "public",
    per_page: 100,
  });

  return repos
    .filter((repo) => repo.archived === false)
    .map((repo) => ({
      full_name: repo.full_name,
      owner: { login: repo.owner?.login ?? orgName },
      name: repo.name,
    }));
}

async function findReadmeFilesInRepo(owner: string, repo: string): Promise<MdFile[]> {
  const octokit = getMyOctokit();
  // Get the default branch (cached, links to the repository reuse the response)
  const { data: repoData } = await getRepoCached(owner, repo);
  const defaultBranch = repoData.default_branch;

  // Get the complete tree with all files
  const { data: treeData } = await octokit.git.getTree({
    owner,
    repo,
    tree_sha: defaultBranch,
    recursive: "1",
  });

  // Filter only markdown files
  const mdFiles = treeData.tree
    .filter((item) => item.type === "blob" && item.path?.toLowerCase().endsWith("readme.md"))
    .map((item) => ({
      sourcePath: `https://github.com/${owner}/${repo}/blob/${defaultBranch}/${item.path}`,
      downloadUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/${item.path}`,
    }));

  return mdFiles;
}

/**
 * Lists README files in all public, non-archived repositories of the organization
 * (sampled according to `LINK_CHECK_SAMPLE_RATE`).
 * @throws {Error} if the repositories cannot be listed
 */
export async function getReadmesFromOrg(orgName: string): Promise<MdFile[]> {
  let repos: Awaited<ReturnType<typeof getOrgRepos>>;
  try {
    repos = await getOrgRepos(orgName);
  } catch (error) {
    throw new Error(
      `Failed to list repositories of GitHub organization ${orgName}: ${(error as Error).message}`
    );
  }
  console.log(`\nFound ${repos.length} public repositories in ${orgName} organization.`);

  const { results, errors } = await parallelProcess({
    items: repos,
    processFn: async (repo) => {
      return findReadmeFilesInRepo(repo.owner.login, repo.name);
    },
  });
  if (errors.length > 0) {
    // Already logged by parallelProcess, make it clear that the README list is incomplete
    console.warn(`Could not list README files in ${errors.length} repositories, their links will not be checked.`);
  }
  const readmes = results.flat();
  console.log(
    `\nFound ${readmes.length} public Readmes files in ${repos.length} repositories of ${orgName} organization.`
  );
  return sampleItems({ items: readmes, key: (readme) => readme.sourcePath, label: "README files" });
}

/** Downloads README files (limited per host) and extracts their links */
export async function getReadmeLinks(files: MdFile[]): Promise<Link[]> {
  console.log(`\nRetrieving links from ${files.length} files...`);
  const { results, errors } = await parallelProcess({
    items: files,
    // Downloads wait for a per-host slot (all files are on raw.githubusercontent.com),
    // every request has its own timeout instead of the task timeout
    taskTimeout: null,
    processFn: async (file) => {
      const response = await fetchWithHostLimit(file.downloadUrl, {}, async (response) =>
        response.ok ? response.text() : ""
      );
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Could not download ${file.downloadUrl}, status: ${response.status}`);
      }
      const links = extractLinksFromMarkdown(response.data, file.sourcePath);
      return links;
    },
  });

  if (errors.length > 0) {
    console.error(
      `Errors fetching files and extracting links: ${errors.length}\n${formatPoolErrors(errors)}`
    );
  }
  const links = results.flat();
  console.log(`Extracted ${links.length} links from ${files.length} files.`);
  return links;
}

/**
 * Checks links in README files of all public repositories of a GitHub organization.
 * Runs as a single run (see `withRun`): GitHub API responses are cached, the browser is closed at the end.
 */
export const checkReadmesInGithubOrg = (org: string) =>
  withRun(async () => {
    const startTime = performance.now();
    await checkGitHubRateLimit(getMyOctokit());

    const fingerprintPublicReadmes = await timePhase("List README files", () => getReadmesFromOrg(org));

    const links = await timePhase("Extract links", () => getReadmeLinks(fingerprintPublicReadmes));
    const filteredLinks = filterOutIrrelevantLinks(links);

    const { results, errors } = await checkLinks({
      links: filteredLinks,
      verbose: true,
      fetchConcurrencyLimit: 20,
    });

    const report = getJSONReport({ links: results, errors, siteName: `${org} GitHub readmes` });

    saveReport(report);
    console.log(report.summary);

    console.log(`\nFinished in ${(performance.now() - startTime) / 1000} seconds.`);

    return report;
  });
