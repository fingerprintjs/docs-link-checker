import { Octokit } from "@octokit/rest";
import dotenv from "dotenv";
import { parallelProcess } from "../utils";
import { Link, LinkCheckResult } from "../types";
import { extractLinksFromMarkdown } from "../markdown";
import { checkLinks } from "../link";
import { getJSONReport, saveReport } from "../report/report";
import { filterOutIrrelevantLinks } from "../page";
import { myGithubClient } from "./githubClient";

const octokit = myGithubClient;

interface MdFile {
  sourcePath: string;
  downloadUrl: string;
}

async function getOrgRepos(orgName: string) {
  const repos = await octokit.paginate(octokit.repos.listForOrg, {
    org: orgName,
    type: "public",
    per_page: 100,
  });

  return repos
    .filter((repo) => repo.archived === false)
    .map((repo) => ({
      full_name: repo.full_name,
      owner: { login: repo.owner!.login },
      name: repo.name,
    }));
}

async function findReadmeFilesInRepo(owner: string, repo: string): Promise<MdFile[]> {
  // Get the default branch
  const { data: repoData } = await octokit.repos.get({
    owner,
    repo,
  });
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

async function getReadmesFromOrg(orgName: string): Promise<MdFile[] | undefined> {
  try {
    const repos = await getOrgRepos(orgName);
    console.log(`\nFound ${repos.length} public repositories in ${orgName} organization.`);

    const { results } = await parallelProcess({
      items: repos,
      processFn: async (repo) => {
        return findReadmeFilesInRepo(repo.owner.login, repo.name);
      },
    });
    const readmes = results.flat();
    console.log(
      `\nFound ${readmes.length} public Readmes files in ${repos.length} repositories of ${orgName} organization.`
    );
    return readmes;
  } catch (error) {
    console.error(`Error getting Readmes from organization ${orgName}: ${(error as Error).message}`);
  }
}

async function getReadmeLinks(files: MdFile[]): Promise<Link[]> {
  console.log(`\nRetrieving links from ${files.length} files...`);
  const { results, errors } = await parallelProcess({
    items: files,
    processFn: async (file) => {
      const markdown = await fetch(file.downloadUrl).then((res) => res.text());
      const links = extractLinksFromMarkdown(markdown, file.sourcePath);
      return links;
    },
  });

  if (errors.length > 0) {
    console.error(`Errors fetching files and extracting links: ${errors.length}`, errors.toString());
  }
  const links = results.flat();
  console.log(`Extracted ${links.length} links from ${files.length} files.`);
  return links;
}

function readableMilliseconds(milliseconds: number) {
  const timeInSeconds = Math.floor(milliseconds / 1000);
  const seconds = timeInSeconds % 60;
  const minutes = Math.floor(timeInSeconds / 60) % 60;
  const hours = Math.floor(timeInSeconds / 3600) % 24;
  const days = Math.floor(timeInSeconds / 86400);
  return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

export async function checkGitHubRateLimit() {
  const response = await octokit.request("GET /rate_limit");
  const resetTime = new Date(response.data.rate.reset * 1000);
  const millisecondsUntilReset = resetTime.getTime() - Date.now();

  console.table({
    "Remaining GitHub API requests": response.data.rate.remaining,
    "Resets in": readableMilliseconds(millisecondsUntilReset),
    "Resets on": resetTime.toLocaleString("fr-FR"),
  });
}

export async function checkReadmesInGithubOrg(org: string) {
  const startTime = performance.now();
  checkGitHubRateLimit();

  const fingerprintPublicReadmes = await getReadmesFromOrg(org);

  const links = await getReadmeLinks(fingerprintPublicReadmes!);
  const filteredLinks = filterOutIrrelevantLinks(links);

  const { results, errors } = await checkLinks({ links: filteredLinks, verbose: true, fetchConcurrencyLimit: 20 });

  const report = getJSONReport({ links: results, errors, siteName: `${org} GitHub readmes` });

  saveReport(report);
  console.log(report.summary);

  console.log(`\nFinished in ${(performance.now() - startTime) / 1000} seconds.`);

  return report;
}


