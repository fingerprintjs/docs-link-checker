import { readFileSync } from "fs";
import { Octokit } from "@octokit/rest";
import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";
import { parallelProcess, progressBar } from "../utils";
import { Link } from "../types";
import { extractLinksFromMarkdown } from "../markdown";
import { checkLinks } from "../link";
import { getJSONReport, saveReport } from "../report/report";
import { filterOutIrrelevantLinks } from "../page";

dotenv.config();

const GH_TOKEN = process.env.GH_TOKEN;
if (!GH_TOKEN) {
  throw new Error("GH_TOKEN is not set");
}

// Initialize without token for public repos, but you can add a token for higher rate limits
const octokit = new Octokit({ auth: GH_TOKEN });

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

    const { results } = await parallelProcess(repos, (repo) => {
      return findReadmeFilesInRepo(repo.owner.login, repo.name);
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
  const { results, errors } = await parallelProcess(files, async (file) => {
    const markdown = await fetch(file.downloadUrl).then((res) => res.text());
    const links = extractLinksFromMarkdown(markdown, file.sourcePath);
    return links;
  });

  if (errors.length > 0) {
    console.error(`Errors fetching files and extracting links: ${errors.length}`, errors.toString());
  }
  const links = results.flat();
  console.log(`Extracted ${links.length} links from ${files.length} files.`);
  return links;
}

export async function checkReadmesInGithubOrg(org: string) {
  const startTime = performance.now();

  const fingerprintPublicReadmes = await getReadmesFromOrg(org);

  const links = await getReadmeLinks(fingerprintPublicReadmes!);
  const filteredLinks = filterOutIrrelevantLinks(links);

  const { results, errors } = await checkLinks({ links: filteredLinks, verbose: true });

  const report = getJSONReport({ links: results, errors, siteName: `${org} GitHub readmes` });

  saveReport(report);
  console.log(report.summary);

  console.log(`\nFinished in ${(performance.now() - startTime) / 1000} seconds.`);

  return report;
}
