/**
 * Links of the README files of a GitHub organization.
 * STUB: implemented by the GITHUB group, except the pure helpers.
 */
import { Effect } from "effect";
import type { RunServices } from "../app";
import type { OrgListError } from "../errors";
import type { Fetch } from "../http";
import type { HostLimiter } from "../limiter";
import type { Metrics } from "../metrics";
import type { Link, LinkWithResult } from "../types";
import type { GitHub } from "./github_client";

export type MdFile = { readonly sourcePath: string; readonly downloadUrl: string };

export const getReadmesFromOrg: (
  org: string,
  sampleRate: number,
) => Effect.Effect<MdFile[], OrgListError, GitHub> = () => Effect.die("not implemented");

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

export const getReadmeLinks: (
  files: ReadonlyArray<MdFile>,
) => Effect.Effect<Link[], never, Fetch | HostLimiter | Metrics> = () =>
  Effect.die("not implemented");

/** Report name of an organization (`fingerprintjs` -> `fingerprintjs-github-readmes.html`) */
export const getGithubOrgSiteName = (org: string) => `${org} GitHub readmes`;

export const checkReadmesInGithubOrg: (
  org: string,
  options: { readonly sampleRate: number },
) => Effect.Effect<LinkWithResult[], OrgListError, RunServices> = () =>
  Effect.die("not implemented");
