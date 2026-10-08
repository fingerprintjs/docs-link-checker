import { Effect } from "effect";
import { Metrics, runCached } from "../run";
import type { LinkCheckResult } from "../types";
import { type GitHubApiError, githubRequest, type MyOctokitInstance } from "./github_client";

/**
 * GitHub API requests shared by the link checks, and the mapping of failed requests to link check results.
 * Responses are cached in memory for the current run (see `RunCache`), concurrent calls share one request: many
 * README links point to the same repositories and files.
 */

/**
 * `true` if a failed GitHub API request is a definitive "missing" answer: 404 Not Found or 410 Gone (deleted issues).
 * Nothing else proves a link is broken: 401 (bad token), 403 (rate limits surface as 403 after Octokit's retry, or no
 * access), 429, 5xx and network errors say nothing about the link.
 */
export const isNotFoundApiError = ({ status }: GitHubApiError): boolean =>
  status === 404 || status === 410;

/**
 * A failed GitHub API request as a link check result: "not found" (see `isNotFoundApiError`) is a broken link,
 * anything else is an "unexpected error", re-checked in the browser (see `shouldRecheckWithPlaywright`)
 */
export const getApiErrorResult = (
  error: GitHubApiError,
  notFoundDetail: string,
): LinkCheckResult => {
  const { status } = error;
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
 * Runs `call` once per `key` in a run. GitHub names (owner, repo, user) are case-insensitive, callers lowercase
 * them in the key.
 * "Not found" is a definitive answer worth caching. Other errors (rate limits, 401/403, 5xx) are retried on the next
 * call.
 */
export const cachedRequest = <T>(
  key: unknown[],
  call: (octokit: MyOctokitInstance) => Promise<T>,
) =>
  Effect.gen(function* () {
    const metrics = yield* Metrics;
    return yield* runCached(`github:${JSON.stringify(key)}`, githubRequest(call), {
      cacheError: isNotFoundApiError,
      // Requests themselves are counted by the Octokit client (see `GitHubClient`)
      onHit: metrics.increment("githubCacheHits"),
    });
  });

/** `GET /repos/{owner}/{repo}`, cached per repository */
export const getRepoCached = (owner: string, repo: string) =>
  cachedRequest(["repo", owner.toLowerCase(), repo.toLowerCase()], (octokit) =>
    octokit.repos.get({ owner, repo }),
  );
