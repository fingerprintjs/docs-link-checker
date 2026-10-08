import { incrementMetric, runCached } from "../run";
import type { LinkCheckResult } from "../types";
import { getMyOctokit } from "./github_client";

/**
 * GitHub API requests shared by the link checks, and the mapping of failed requests to link check results.
 * Responses are cached in memory for the current run (see `withRun`), concurrent calls share one request: many
 * README links point to the same repositories and files. Outside of a run, nothing is cached.
 */

/** HTTP status of a failed GitHub API request, `undefined` without a response (network error, no `GH_TOKEN`) */
export const getApiErrorStatus = (error: unknown): number | undefined =>
  typeof error === "object" &&
  error !== null &&
  "status" in error &&
  typeof error.status === "number"
    ? error.status
    : undefined;

/**
 * `true` if a failed GitHub API request is a definitive "missing" answer: 404 Not Found or 410 Gone (deleted issues).
 * Nothing else proves a link is broken: 401 (bad token), 403 (rate limits surface as 403 after Octokit's retry, or no
 * access), 429, 5xx and network errors say nothing about the link.
 */
export const isNotFoundApiError = (error: unknown): boolean => {
  const status = getApiErrorStatus(error);
  return status === 404 || status === 410;
};

/**
 * A failed GitHub API request as a link check result: "not found" (see `isNotFoundApiError`) is a broken link,
 * anything else is an "unexpected error", re-checked in the browser (see `shouldRecheckWithPlaywright`)
 */
export const getApiErrorResult = (error: unknown, notFoundDetail: string): LinkCheckResult => {
  const status = getApiErrorStatus(error);
  if (isNotFoundApiError(error)) {
    return { ok: false, error: "broken link", status, errorDetail: notFoundDetail };
  }
  return {
    ok: false,
    error: "unexpected error",
    ...(status !== undefined ? { status } : {}),
    errorDetail: String(error),
  };
};

/**
 * Runs `request` once per `key` in a run. GitHub names (owner, repo, user) are case-insensitive, callers lowercase
 * them in the key.
 * "Not found" is a definitive answer worth caching. Other errors (rate limits, 401/403, 5xx) are retried on the next
 * call.
 */
export const cachedRequest = <T>(
  key: unknown[],
  request: (octokit: ReturnType<typeof getMyOctokit>) => Promise<T>,
): Promise<T> =>
  // `async`: a client that can't be created (no `GH_TOKEN`) rejects the promise instead of throwing
  runCached(`github:${JSON.stringify(key)}`, async () => request(getMyOctokit()), {
    cacheError: isNotFoundApiError,
    // Requests themselves are counted by the Octokit client (see `countRequests`)
    onHit: () => incrementMetric("githubCacheHits"),
  });

/** `GET /repos/{owner}/{repo}`, cached per repository */
export const getRepoCached = (owner: string, repo: string) =>
  cachedRequest(["repo", owner.toLowerCase(), repo.toLowerCase()], (octokit) =>
    octokit.repos.get({ owner, repo }),
  );
