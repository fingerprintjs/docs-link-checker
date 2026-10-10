import { getDeps, getHostLimiter, getTerminal, incrementMetric } from "../run";
import type { LinkCheckResult } from "../types";
/**
 * HTTP for link checks, shared by the fetch and the Playwright checks:
 * - `fetchWithHostLimit`: requests limited per host, with redirects and retries of 429 and 502, 503, 504
 * - `classifyStatus` and the server error helpers: one decision of what a status means and when to retry,
 *   so both check methods treat statuses the same way
 * - `USER_AGENT` and `TASK_TIMEOUT`
 */
import { stripHash } from "./hash";
import { parseRetryAfter } from "./limiter";

// GitHub web rate limit makes you wait 60 seconds after 500 requests
export const TASK_TIMEOUT = 80000;
// Timeout of a single fetch request
const FETCH_TIMEOUT = 20000;

const OKAY_STATUS_CODES = new Set([200, 301, 302, 303, 307, 308]);
// Some websites have ReCaptcha or other anti-scraping measures that prevent us from checking their links, let's ignore/collect them separately
const FORBIDDEN_STATUS_CODES = new Set([403, 401]);
// The server is overloaded or restarting (or rate limiting, like github.com under load), says nothing about the link.
// Retried with a backoff (see `planServerErrorRetry`), reported as "could not check" if it persists.
const TRANSIENT_SERVER_ERROR_STATUS_CODES = new Set([502, 503, 504]);

/**
 * What a status means for a link check. Callers decide what to do with `forbidden` (the fetch check reports it as
 * a broken link and lets the Playwright re-check decide, Playwright reports "could not check").
 */
export const classifyStatus = (status: number): "okay" | "forbidden" | "server-error" | "other" => {
  if (OKAY_STATUS_CODES.has(status)) {
    return "okay";
  }
  if (FORBIDDEN_STATUS_CODES.has(status)) {
    return "forbidden";
  }
  if (TRANSIENT_SERVER_ERROR_STATUS_CODES.has(status)) {
    return "server-error";
  }
  return "other";
};

// Desktop Chrome user agent, some websites refuse requests from unknown clients.
// One fixed value (not rotated) so runs are repeatable. Update the Chrome version now and then.
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/** `USER_AGENT`, or `undefined` for sites that block you when the user agent is spoofed (android.com) */
export const getUserAgent = (url: string): string | undefined =>
  url.includes("android.com") ? undefined : USER_AGENT;

// How many times a request is retried after a 429 with `Retry-After`
const MAX_RATE_LIMIT_RETRIES = 2;
// How many times a request (or a Playwright navigation) is retried after a 502, 503 or 504
const MAX_SERVER_ERROR_RETRIES = 2;
// Backoff before each server error retry, when the response has no (shorter) `Retry-After`
const SERVER_ERROR_RETRY_DELAYS = [2000, 5000];
// Longest wait before a server error retry: a longer `Retry-After` is not waited for, the request gives up.
// Bounds the added wait per request to `MAX_SERVER_ERROR_RETRIES * MAX_SERVER_ERROR_RETRY_DELAY` (20s).
const MAX_SERVER_ERROR_RETRY_DELAY = 10000;

/**
 * Decides if a request (or navigation) that got a 502, 503 or 504 is retried. If so, logs it and returns the delay
 * to wait; `undefined` to give up: after `MAX_SERVER_ERROR_RETRIES` retries, or when `Retry-After` asks for more
 * than `MAX_SERVER_ERROR_RETRY_DELAY`. A `Retry-After` is respected (never retried sooner), the backoff is the minimum.
 * @param retries retries done so far
 */
export const planServerErrorRetry = (
  url: string,
  status: number,
  retries: number,
  retryAfter: string | null,
): number | undefined => {
  if (retries >= MAX_SERVER_ERROR_RETRIES) {
    return undefined;
  }
  const backoff =
    SERVER_ERROR_RETRY_DELAYS[Math.min(retries, SERVER_ERROR_RETRY_DELAYS.length - 1)] ?? 0;
  const retryAfterMs = parseRetryAfter(retryAfter);
  if (retryAfterMs !== undefined && retryAfterMs > MAX_SERVER_ERROR_RETRY_DELAY) {
    return undefined;
  }
  const delayMs = Math.min(Math.max(backoff, retryAfterMs ?? 0), MAX_SERVER_ERROR_RETRY_DELAY);
  getTerminal().verbose(
    `Server error ${status} (${url}), retrying after ${Math.ceil(delayMs / 1000)}s...`,
  );
  incrementMetric("serverErrorRetries");
  return delayMs;
};

/** Result for a 502, 503 or 504 that persisted after the retries: it says nothing about the link */
export const serverErrorResult = (status: number, statusText: string): LinkCheckResult => ({
  ok: false,
  error: "could not check",
  status,
  errorDetail: `Server error ${status}${statusText ? ` ${statusText}` : ""} (overloaded or rate limiting), still failing after up to ${MAX_SERVER_ERROR_RETRIES} retries`,
});

/**
 * The final URL of a request if it ended on a different page than requested. A trailing slash or hash difference is
 * not a redirect worth reporting.
 */
export const getRedirectTarget = (requestedUrl: string, finalUrl: string): string | undefined => {
  if (!URL.canParse(requestedUrl) || !URL.canParse(finalUrl)) {
    return undefined;
  }
  const withoutNoise = (url: string) => {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.href;
  };
  return withoutNoise(finalUrl) === withoutNoise(requestedUrl) ? undefined : stripHash(finalUrl);
};

// Redirects followed per request (like `fetch`, which gives up after 20; 10 is plenty for real links)
const MAX_REDIRECTS = 10;

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

type LimitedResponse<T> = {
  status: number;
  statusText: string;
  headers: Headers;
  /** Final URL, after redirects (like `Response.url`) */
  url: string;
  /** What `read` returned for the final response */
  data: T;
};

type LimitedRequestOptions = {
  /** Default `GET`, kept across redirects */
  method?: "GET" | "HEAD";
  headers?: HeadersInit;
  /** Timeout of each request (each redirect hop), default `FETCH_TIMEOUT` */
  timeoutMs?: number;
};

/** Log message for a rate-limited request that is retried (the header can be seconds or an HTTP date) */
const formatRateLimitRetry = (url: string, delayMs: number, retryAfter: string | null) =>
  `Rate limited (${url}), retrying after ${Math.ceil(delayMs / 1000)}s (Retry-After: ${retryAfter})...`;

/** Cancels the response body if it was not consumed (frees the connection) */
const discardBody = async (response: Response) => {
  if (!response.bodyUsed) {
    await response.body?.cancel().catch(() => {});
  }
};

type HopResult<T> =
  | { type: "retry" }
  | { type: "server-error-retry" }
  | { type: "redirect"; location: string }
  | { type: "final"; response: Omit<LimitedResponse<T>, "url"> };

/**
 * Sends a request limited per host (see `getHostLimiter`):
 * - Redirects are followed manually (at most `MAX_REDIRECTS`), every hop waits for a slot of *its* host, so requests
 *   redirected from many hosts to the same destination still respect the destination's limit.
 * - A 429 with a usable `Retry-After` pauses the whole host *before* the slot is released (so no queued request to
 *   that host starts during the pause), then the request is retried, at most `MAX_RATE_LIMIT_RETRIES` times.
 * - A 502, 503 or 504 is retried too (at most `MAX_SERVER_ERROR_RETRIES` times), after a backoff or the
 *   `Retry-After` delay (see `planServerErrorRetry`). The host is paused in the same way, so concurrent requests to an overloaded host
 *   back off as well.
 * - The final response (possibly still a 429 or 5xx) is returned. `read` consumes what it needs of the body inside the slot,
 *   any unread body (also of redirect and 429 responses) is cancelled before the slot is released.
 * @throws {Error} on network errors, timeouts and too many redirects (like `fetch`)
 */
export const fetchWithHostLimit = async <T>(
  url: string,
  { method = "GET", headers, timeoutMs = FETCH_TIMEOUT }: LimitedRequestOptions,
  read: (response: Response) => Promise<T>,
): Promise<LimitedResponse<T>> => {
  const hostLimiter = getHostLimiter();
  let currentUrl = url;
  let redirects = 0;
  let rateLimitRetries = 0;
  let serverErrorRetryCount = 0;

  for (;;) {
    const requestUrl = currentUrl;
    const result = await hostLimiter.run(requestUrl, async (): Promise<HopResult<T>> => {
      // Counted per actual request (every redirect hop and retry)
      incrementMetric("httpRequests");
      const response = await (getDeps().fetch ?? fetch)(requestUrl, {
        method,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      try {
        const location = response.headers.get("Location");
        // An empty Location is a valid (relative) target, it resolves to the current URL
        if (REDIRECT_STATUS_CODES.has(response.status) && location !== null) {
          return { type: "redirect", location };
        }
        if (response.status === 429 && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
          const retryAfter = response.headers.get("Retry-After");
          const retryAfterMs = parseRetryAfter(retryAfter);
          if (retryAfterMs !== undefined && retryAfterMs < TASK_TIMEOUT) {
            // Retry-After is either a number of seconds or an HTTP date, log the parsed delay
            getTerminal().verbose(formatRateLimitRetry(requestUrl, retryAfterMs, retryAfter));
            // Pause the whole host while still holding the slot
            hostLimiter.pause(requestUrl, retryAfterMs);
            return { type: "retry" };
          }
        }
        if (classifyStatus(response.status) === "server-error") {
          const delayMs = planServerErrorRetry(
            requestUrl,
            response.status,
            serverErrorRetryCount,
            response.headers.get("Retry-After"),
          );
          if (delayMs !== undefined) {
            // Like a 429: the whole host backs off while the slot is still held
            hostLimiter.pause(requestUrl, delayMs);
            return { type: "server-error-retry" };
          }
        }
        return {
          type: "final",
          response: {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
            data: await read(response),
          },
        };
      } finally {
        // Whatever was not consumed is cancelled before the slot is released,
        // so no response stream stays active outside the per-host limit
        await discardBody(response);
      }
    });

    switch (result.type) {
      case "final":
        return { ...result.response, url: currentUrl };
      case "retry":
        rateLimitRetries++;
        break;
      case "server-error-retry":
        serverErrorRetryCount++;
        break;
      case "redirect":
        if (redirects >= MAX_REDIRECTS) {
          throw new Error(`Too many redirects (more than ${MAX_REDIRECTS}) for ${url}`);
        }
        redirects++;
        currentUrl = new URL(result.location, currentUrl).href;
        break;
    }
  }
};
