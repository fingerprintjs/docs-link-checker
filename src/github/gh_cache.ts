import { incrementMetric, runCached } from "../run_context";
import { getMyOctokit } from "./github_client";

/**
 * GitHub API responses cached in memory for the current run (see `withRun`), concurrent calls share one request.
 * Many README links point to the same repositories and files. Outside of a run, nothing is cached.
 */

type Octokit = ReturnType<typeof getMyOctokit>;
export type RepoResponse = Awaited<ReturnType<Octokit["repos"]["get"]>>;
export type UserResponse = Awaited<ReturnType<Octokit["users"]["getByUsername"]>>;
export type ContentResponse = Awaited<ReturnType<Octokit["repos"]["getContent"]>>;
export type BlobResponse = Awaited<ReturnType<Octokit["git"]["getBlob"]>>;

// "Not found" is a definitive answer worth caching. Other errors (rate limits, 5xx) are retried on the next call.
const isNotFound = (error: unknown) => (error as { status?: number } | undefined)?.status === 404;

/**
 * A failed API request that says nothing about the link: a server error or rate limit (after Octokit's own retries),
 * or no HTTP response at all (network error)
 */
export const isTransientApiError = (error: unknown): boolean => {
  const status = (error as { status?: number } | undefined)?.status;
  return status === undefined || status === 429 || status >= 500;
};

// `async`: a client that can't be created (no `GH_TOKEN`) rejects the promise instead of throwing
const cachedRequest = <T>(key: string, request: () => Promise<T>): Promise<T> =>
  runCached(`github:${key}`, async () => request(), {
    cacheError: isNotFound,
    // Requests themselves are counted by the Octokit client (see `countRequests`)
    onHit: () => incrementMetric("githubCacheHits"),
  });

/** `GET /repos/{owner}/{repo}`, cached per repository (GitHub names are case-insensitive) */
export const getRepoCached = (owner: string, repo: string): Promise<RepoResponse> =>
  cachedRequest(`repo:${owner}/${repo}`.toLowerCase(), () =>
    getMyOctokit().repos.get({ owner, repo }),
  );

/** `GET /users/{username}` (users and organizations), cached per account (names are case-insensitive) */
export const getUserCached = (username: string): Promise<UserResponse> =>
  cachedRequest(`user:${username}`.toLowerCase(), () =>
    getMyOctokit().users.getByUsername({ username }),
  );

type ContentParams = { owner: string; repo: string; ref: string; path: string };

/** `GET /repos/{owner}/{repo}/contents/{path}?ref={ref}`, cached per (owner, repo, ref, path) */
export const getContentCached = ({
  owner,
  repo,
  ref,
  path,
}: ContentParams): Promise<ContentResponse> =>
  cachedRequest(
    `content:${JSON.stringify([owner.toLowerCase(), repo.toLowerCase(), ref, path])}`,
    () => getMyOctokit().repos.getContent({ owner, repo, ref, path }),
  );

/**
 * `GET /repos/{owner}/{repo}/git/blobs/{sha}`, cached per blob (a blob never changes).
 * For files over 1 MB, the contents API has no content, the blob API returns files up to 100 MB.
 */
export const getBlobCached = (owner: string, repo: string, sha: string): Promise<BlobResponse> =>
  cachedRequest(`blob:${JSON.stringify([owner.toLowerCase(), repo.toLowerCase(), sha])}`, () =>
    getMyOctokit().git.getBlob({ owner, repo, file_sha: sha }),
  );
