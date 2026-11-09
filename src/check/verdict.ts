/**
 * What a link check result means, in one place. The checkers load pages and look for anchors, this module decides:
 * - `planRetry`: if a response (429, 502, 503, 504) is retried, and after how long
 * - `judgePage`: what a loaded page (a response, no response, or an error) means for links to it
 * - `judgeLink`: the result of one link (maybe with a hash) on that page
 * - `shouldRecheckWithPlaywright`: if a first-pass result is re-checked in the browser
 *
 * See `LinkCheckResult` in `../types.ts` for what each error means in the report.
 */
import type { LinkCheckResult } from "../types";
import { parseRetryAfter } from "../utils/limiter";
import { getSpecialFragmentNote } from "./hash";

/** Checks that load a page: plain `fetch` (first pass) or a Playwright navigation (re-check) */
type PageChecker = "fetch" | "playwright";

// Redirects are only "okay" when they end a request: `fetch` follows those with a Location, Playwright all of them
const OKAY_REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const isOkayStatus = (status: number) =>
  (status >= 200 && status < 300) || OKAY_REDIRECT_STATUS_CODES.has(status);
// Some websites have ReCaptcha or other anti-scraping measures that prevent us from checking their links
const FORBIDDEN_STATUS_CODES = new Set([401, 403]);
// The server is overloaded or restarting (or rate limiting, like github.com under load), says nothing about the link.
// Retried with a backoff, reported as "could not check" if it persists.
const SERVER_ERROR_STATUS_CODES = new Set([502, 503, 504]);
// Statuses of a `fetch` "broken link" that might be caused by bot protection or the request itself
const RECHECK_STATUS_CODES = new Set([401, 403, 405, 406, 408]);

// How many times a request is retried after a 429 with `Retry-After`
const MAX_RATE_LIMIT_RETRIES = 2;
// GitHub web rate limit makes you wait 60 seconds after 500 requests. A longer `Retry-After` is not waited for.
const MAX_RATE_LIMIT_WAIT = 80000;
// How many times a request (or a Playwright navigation) is retried after a 502, 503 or 504
const MAX_SERVER_ERROR_RETRIES = 2;
// Backoff before each server error retry, when the response has no (longer) `Retry-After`
const SERVER_ERROR_RETRY_DELAYS = [2000, 5000];
// Longest wait before a server error retry: a longer `Retry-After` is not waited for, the request gives up.
// Bounds the added wait per request to `MAX_SERVER_ERROR_RETRIES * MAX_SERVER_ERROR_RETRY_DELAY` (20s).
const MAX_SERVER_ERROR_RETRY_DELAY = 10000;

type RetryReason = "rate-limited" | "server-error";

export type RetryPlan = { reason: RetryReason; delayMs: number };

/**
 * Decides if a response (of a request or a Playwright navigation) is retried, and after how long. `undefined` to give
 * up and judge the response as it is.
 * - 429: after its `Retry-After`, if it has one shorter than `MAX_RATE_LIMIT_WAIT`
 * - 502, 503, 504: after a backoff, or a longer `Retry-After` up to `MAX_SERVER_ERROR_RETRY_DELAY`
 * @param response.retryAfter raw `Retry-After` header (seconds or an HTTP date)
 * @param retries retries done so far, by reason
 */
export const planRetry = (
  { status, retryAfter }: { status: number; retryAfter: string | null },
  retries: Readonly<Record<RetryReason, number>>,
): RetryPlan | undefined => {
  const retryAfterMs = parseRetryAfter(retryAfter);
  if (status === 429) {
    if (
      retries["rate-limited"] < MAX_RATE_LIMIT_RETRIES &&
      retryAfterMs !== undefined &&
      retryAfterMs < MAX_RATE_LIMIT_WAIT
    ) {
      return { reason: "rate-limited", delayMs: retryAfterMs };
    }
    return undefined;
  }
  if (!SERVER_ERROR_STATUS_CODES.has(status)) {
    return undefined;
  }
  const done = retries["server-error"];
  if (done >= MAX_SERVER_ERROR_RETRIES) {
    return undefined;
  }
  if (retryAfterMs !== undefined && retryAfterMs > MAX_SERVER_ERROR_RETRY_DELAY) {
    return undefined;
  }
  const backoff =
    SERVER_ERROR_RETRY_DELAYS[Math.min(done, SERVER_ERROR_RETRY_DELAYS.length - 1)] ?? 0;
  // A `Retry-After` is respected (never retried sooner), the backoff is the minimum
  return {
    reason: "server-error",
    delayMs: Math.min(Math.max(backoff, retryAfterMs ?? 0), MAX_SERVER_ERROR_RETRY_DELAY),
  };
};

/** What a checker got when it loaded a page (URL without hash) */
export type PageLoad =
  | {
      type: "response";
      status: number;
      statusText: string;
      /** Raw `Retry-After` header */
      retryAfter: string | null;
      /** Only called when the result shows the body (error pages) */
      readBody: () => Promise<string>;
    }
  /** Playwright navigation without a response (e.g. only the hash changed) */
  | { type: "no-response" }
  /** Network error, timeout, too many redirects... */
  | { type: "error"; error: unknown };

/** A loaded page: its links can be checked (`ok`), or they all get `result` */
export type PageVerdict = { ok: true; status: number } | { ok: false; result: LinkCheckResult };

// Longest part of an error page body kept in the result detail (results of every link are kept until the report)
const MAX_BODY_SNIPPET_LENGTH = 500;

/** `summary` and the start of the error page body, for the result detail */
const withBodySnippet = (summary: string, body: string): string => {
  const trimmed = body.trim();
  const snippet =
    trimmed.length > MAX_BODY_SNIPPET_LENGTH
      ? `${trimmed.slice(0, MAX_BODY_SNIPPET_LENGTH)}…`
      : trimmed;
  return [summary, snippet].filter(Boolean).join(" ");
};

/**
 * What a loaded page means for the links to it. Retries (see `planRetry`) are done, this is the final answer.
 * - Every failed status has the start of the error page body in its detail
 * - 401, 403: `fetch` says "broken link", so they are re-checked with Playwright (see `shouldRecheckWithPlaywright`),
 *   which says "could not check" (bot protection, login)
 * - Errors are "broken link": `fetch` errors are re-checked with Playwright, so a server that is down ends as a
 *   broken link
 */
export const judgePage = async (checker: PageChecker, load: PageLoad): Promise<PageVerdict> => {
  if (load.type === "no-response") {
    return { ok: false, result: { ok: false, error: "broken link", errorDetail: "No response" } };
  }
  if (load.type === "error") {
    return {
      ok: false,
      result: { ok: false, error: "broken link", errorDetail: String(load.error) },
    };
  }

  const { status, statusText, retryAfter, readBody } = load;
  if (isOkayStatus(status)) {
    return { ok: true, status };
  }
  const fail = async (
    error: "broken link" | "could not check",
    summary: string,
  ): Promise<PageVerdict> => ({
    ok: false,
    result: { ok: false, error, status, errorDetail: withBodySnippet(summary, await readBody()) },
  });

  // Still rate limited after the retries (or asked to wait longer than we do): says nothing about the link
  if (status === 429) {
    // Raw header without a unit: it can be seconds or an HTTP date
    return fail(
      "could not check",
      retryAfter
        ? `Rate limited, gave up (Retry-After: ${retryAfter})`
        : "Rate limited, no Retry-After",
    );
  }
  // Still failing after the retries: the server is overloaded, not the link broken
  if (SERVER_ERROR_STATUS_CODES.has(status)) {
    return fail(
      "could not check",
      `Server error ${status}${statusText ? ` ${statusText}` : ""} (overloaded or rate limiting), still failing after up to ${MAX_SERVER_ERROR_RETRIES} retries`,
    );
  }
  if (checker === "playwright" && FORBIDDEN_STATUS_CODES.has(status)) {
    return fail("could not check", statusText);
  }
  return fail("broken link", statusText);
};

/**
 * The result of a link on a loaded page. A hash is looked for with `isHashPresent`, unless it is not an anchor
 * (see `getSpecialFragmentNote`).
 * @param redirectedTo where the page request ended, if not on the requested page (see `getRedirectTarget`)
 * @param isHashPresent gets the hash without `#`
 */
export const judgeLink = async (
  url: string,
  page: PageVerdict,
  {
    redirectedTo,
    isHashPresent,
  }: {
    redirectedTo?: string;
    isHashPresent: (fragment: string) => boolean | Promise<boolean>;
  },
): Promise<LinkCheckResult> => {
  const redirect = redirectedTo ? { redirectedTo } : {};
  if (!page.ok) {
    return { ...page.result, ...redirect };
  }
  const { status } = page;
  const fragment = new URL(url).hash.slice(1);
  if (!fragment) {
    return { ok: true, status, ...redirect };
  }
  const note = getSpecialFragmentNote(fragment, url);
  if (note) {
    return { ok: true, status, note, ...redirect };
  }
  if (!(await isHashPresent(fragment))) {
    return { ok: false, status, error: "hash not found", ...redirect };
  }
  return { ok: true, status, ...redirect };
};

/**
 * Decides if a failed first-pass result is re-checked with Playwright. Only failures that could be caused by the
 * check method itself (client-side rendering, bot blocking, rate limiting, network errors) are re-checked.
 * - `github-api`: "broken link" and "hash not found" are definitive. "unexpected error" (unknown link type, API
 *   errors, rate limits, no `GH_TOKEN`) might still work in a browser.
 * - `fetch`: everything except a "broken link" with a status that says the page is missing (404, 410...)
 */
export const shouldRecheckWithPlaywright = (
  firstPass: "fetch" | "github-api",
  result: LinkCheckResult,
): boolean => {
  if (result.ok) {
    return false;
  }
  if (firstPass === "github-api") {
    return result.error === "unexpected error";
  }
  if (result.error !== "broken link") {
    // "hash not found" (the page might be client-side rendered), "could not check", "unexpected error"
    return true;
  }
  // No status means a network error or a timeout
  return (
    result.status === undefined || RECHECK_STATUS_CODES.has(result.status) || result.status >= 500
  );
};
