import type { LinkCheckResult } from "../types";

/** HTTP status of a failed GitHub API request, `undefined` without a response (network error, no `GH_TOKEN`) */
export const getApiErrorStatus = (error: unknown): number | undefined =>
  (error as { status?: number } | null | undefined)?.status;

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
