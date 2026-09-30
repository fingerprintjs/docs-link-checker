import { incrementMetric, runCached } from "../run_context";
import { getMyOctokit } from "./github_client";

/**
 * GitHub API responses cached in memory for the current run (see `withRun`), concurrent calls share one request.
 * Many README links point to the same repositories and files. Outside of a run, nothing is cached.
 */

type Octokit = ReturnType<typeof getMyOctokit>;
export type RepoResponse = Awaited<ReturnType<Octokit["repos"]["get"]>>;
export type ContentResponse = Awaited<ReturnType<Octokit["repos"]["getContent"]>>;

// "Not found" is a definitive answer worth caching. Other errors (rate limits, 5xx) are retried on the next call.
const isNotFound = (error: unknown) => (error as { status?: number } | undefined)?.status === 404;

const cachedRequest = <T>(key: string, request: () => Promise<T>): Promise<T> =>
  runCached(`github:${key}`, request, {
    cacheError: isNotFound,
    // Requests themselves are counted by the Octokit client (see `countRequests`)
    onHit: () => incrementMetric("githubCacheHits"),
  });

/** `GET /repos/{owner}/{repo}`, cached per repository (GitHub names are case-insensitive) */
export const getRepoCached = (owner: string, repo: string): Promise<RepoResponse> =>
  cachedRequest(`repo:${owner}/${repo}`.toLowerCase(), () => getMyOctokit().repos.get({ owner, repo }));

type ContentParams = { owner: string; repo: string; ref: string; path: string };

/** `GET /repos/{owner}/{repo}/contents/{path}?ref={ref}`, cached per (owner, repo, ref, path) */
export const getContentCached = ({ owner, repo, ref, path }: ContentParams): Promise<ContentResponse> =>
  cachedRequest(`content:${JSON.stringify([owner.toLowerCase(), repo.toLowerCase(), ref, path])}`, () =>
    getMyOctokit().repos.getContent({ owner, repo, ref, path })
  );
