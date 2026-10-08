/**
 * Failed GitHub API call as a link check result.
 */
import type { GitHubApiError } from "../errors";
import type { LinkCheckResult } from "../types";

/**
 * "Not found" (404/410) is a broken link with `notFoundDetail`, anything else an "unexpected error" that is
 * re-checked in the browser: nothing else proves a link is broken (401, 403, 429, 5xx, network errors).
 */
export const getApiErrorResult = (
  error: GitHubApiError,
  notFoundDetail: string,
): LinkCheckResult =>
  error.isNotFound
    ? { ok: false, error: "broken link", status: error.status, errorDetail: notFoundDetail }
    : {
        ok: false,
        error: "unexpected error",
        ...(error.status !== undefined ? { status: error.status } : {}),
        errorDetail: String(error),
      };
