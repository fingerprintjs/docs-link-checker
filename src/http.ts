import { assertDestinationAllowed } from "./destination";
import { parseRetryAfter } from "./limiter";
import { getHostLimiter, incrementMetric } from "./run";

// GitHub web rate limit makes you wait 60 seconds after 500 requests
export const TASK_TIMEOUT = 80000;
// Timeout of a single fetch request
const FETCH_TIMEOUT = 20000;

export const OKAY_STATUS_CODES = [200, 301, 302, 303, 307, 308];
// Some websites have ReCaptcha or other anti-scraping measures that prevent us from checking their links, let's ignore/collect them separately
export const FORBIDDEN_STATUS_CODES = [403, 401];
// The server is overloaded or restarting (or rate limiting, like github.com under load), says nothing about the link.
// Retried with a backoff (see `getServerErrorRetryDelay`), reported as "could not check" if it persists.
export const TRANSIENT_SERVER_ERROR_STATUS_CODES = [502, 503, 504];

// Spoofed user agents to bypass some websites restrictions

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

const userAgents = [
  DEFAULT_USER_AGENT,
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:110.0) Gecko/20100101 Firefox/110.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/109.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Android 14; Mobile; rv:110.0) Gecko/110.0 Firefox/110.0",
  "Mozilla/5.0 (Linux; Android 13; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/537.36",
  "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
];

export const getRandomUserAgent = (): string =>
  userAgents[Math.floor(Math.random() * userAgents.length)] ?? DEFAULT_USER_AGENT;

// How many times a request is retried after a 429 with `Retry-After`
export const MAX_RATE_LIMIT_RETRIES = 2;
// How many times a request (or a Playwright navigation) is retried after a 502, 503 or 504
export const MAX_SERVER_ERROR_RETRIES = 2;
// Backoff before each server error retry, when the response has no (shorter) `Retry-After`
const DEFAULT_SERVER_ERROR_RETRY_DELAYS = [2000, 5000];
// Longest wait before a server error retry: a longer `Retry-After` is not waited for, the request gives up.
// Bounds the added wait per request to `MAX_SERVER_ERROR_RETRIES * MAX_SERVER_ERROR_RETRY_DELAY` (20s).
export const MAX_SERVER_ERROR_RETRY_DELAY = 10000;

let serverErrorRetryDelays = DEFAULT_SERVER_ERROR_RETRY_DELAYS;
/** Only for tests: replace (or reset with `undefined`) the server error backoff */
export const setServerErrorRetryDelays = (delays: number[] | undefined) => {
  serverErrorRetryDelays = delays ?? DEFAULT_SERVER_ERROR_RETRY_DELAYS;
};

/**
 * Delay before the next retry of a transient server error (`TRANSIENT_SERVER_ERROR_STATUS_CODES`), `undefined` to give
 * up: after `maxRetries` retries, or when `Retry-After` asks for more than `MAX_SERVER_ERROR_RETRY_DELAY`.
 * A `Retry-After` is respected (never retried sooner), the backoff is the minimum.
 * @param retries retries done so far
 */
export const getServerErrorRetryDelay = (
  retries: number,
  retryAfter: string | null,
  maxRetries = MAX_SERVER_ERROR_RETRIES,
): number | undefined => {
  if (retries >= maxRetries) {
    return undefined;
  }
  const backoff = serverErrorRetryDelays[Math.min(retries, serverErrorRetryDelays.length - 1)] ?? 0;
  const retryAfterMs = parseRetryAfter(retryAfter);
  if (retryAfterMs !== undefined && retryAfterMs > MAX_SERVER_ERROR_RETRY_DELAY) {
    return undefined;
  }
  return Math.min(Math.max(backoff, retryAfterMs ?? 0), MAX_SERVER_ERROR_RETRY_DELAY);
};

/** Log message for a request (or navigation) retried after a server error */
export const formatServerErrorRetry = (url: string, status: number, delayMs: number) =>
  `Server error ${status} (${url}), retrying after ${Math.ceil(delayMs / 1000)}s...`;
// Redirects followed per request (like `fetch`, which gives up after 20; 10 is plenty for real links)
export const MAX_REDIRECTS = 10;

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

export type LimitedResponse<T> = {
  status: number;
  statusText: string;
  headers: Headers;
  /** Final URL, after redirects (like `Response.url`) */
  url: string;
  /** What `read` returned for the final response */
  data: T;
};

export type LimitedRequestOptions = {
  /** Default `GET` */
  method?: string;
  headers?: HeadersInit;
  /** Timeout of each request (each redirect hop), default `FETCH_TIMEOUT` */
  timeoutMs?: number;
  /** Retries after a 502, 503 or 504, default `MAX_SERVER_ERROR_RETRIES` */
  serverErrorRetries?: number;
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

/**
 * Method for the next request after a redirect (fetch spec): 303 switches to GET (except HEAD),
 * 301 and 302 switch POST to GET, anything else keeps the method.
 */
export const getRedirectMethod = (status: number, method: string): string => {
  const upper = method.toUpperCase();
  if (status === 303 && upper !== "GET" && upper !== "HEAD") {
    return "GET";
  }
  if ((status === 301 || status === 302) && upper === "POST") {
    return "GET";
  }
  return method;
};

type HopResult<T> =
  | { type: "retry" }
  | { type: "server-error-retry" }
  | { type: "redirect"; location: string; status: number }
  | { type: "final"; response: Omit<LimitedResponse<T>, "url"> };

/**
 * Sends a request limited per host (see `getHostLimiter`):
 * - Redirects are followed manually (at most `MAX_REDIRECTS`), every hop waits for a slot of *its* host, so requests
 *   redirected from many hosts to the same destination still respect the destination's limit.
 * - A 429 with a usable `Retry-After` pauses the whole host *before* the slot is released (so no queued request to
 *   that host starts during the pause), then the request is retried, at most `MAX_RATE_LIMIT_RETRIES` times.
 * - A 502, 503 or 504 is retried too (at most `serverErrorRetries` times), after a backoff or the `Retry-After` delay
 *   (see `getServerErrorRetryDelay`). The host is paused in the same way, so concurrent requests to an overloaded host
 *   back off as well.
 * - The final response (possibly still a 429 or 5xx) is returned. `read` consumes what it needs of the body inside the slot,
 *   any unread body (also of redirect and 429 responses) is cancelled before the slot is released.
 * - Every hop must go to a public address (see `src/destination.ts`), a blocked hop is never sent.
 * @throws {DestinationNotAllowedError} for a non-public destination (also after a redirect)
 * @throws {Error} on network errors, timeouts and too many redirects (like `fetch`)
 */
export const fetchWithHostLimit = async <T>(
  url: string,
  {
    method = "GET",
    headers,
    timeoutMs = FETCH_TIMEOUT,
    serverErrorRetries = MAX_SERVER_ERROR_RETRIES,
  }: LimitedRequestOptions,
  read: (response: Response) => Promise<T>,
): Promise<LimitedResponse<T>> => {
  const hostLimiter = getHostLimiter();
  let currentUrl = url;
  let currentMethod = method;
  let redirects = 0;
  let rateLimitRetries = 0;
  let serverErrorRetryCount = 0;

  for (;;) {
    const requestUrl = currentUrl;
    const requestMethod = currentMethod;
    // SSRF guard: every hop (the first request and every redirect) must go to a public address
    await assertDestinationAllowed(requestUrl);
    const result = await hostLimiter.run(requestUrl, async (): Promise<HopResult<T>> => {
      // Counted per actual request (every redirect hop and retry)
      incrementMetric("httpRequests");
      const response = await fetch(requestUrl, {
        method: requestMethod,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      try {
        const location = response.headers.get("Location");
        // An empty Location is a valid (relative) target, it resolves to the current URL
        if (REDIRECT_STATUS_CODES.has(response.status) && location !== null) {
          return { type: "redirect", location, status: response.status };
        }
        if (response.status === 429 && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
          const retryAfter = response.headers.get("Retry-After");
          const retryAfterMs = parseRetryAfter(retryAfter);
          if (retryAfterMs !== undefined && retryAfterMs < TASK_TIMEOUT) {
            // Retry-After is either a number of seconds or an HTTP date, log the parsed delay
            console.log(formatRateLimitRetry(requestUrl, retryAfterMs, retryAfter));
            // Pause the whole host while still holding the slot
            hostLimiter.pause(requestUrl, retryAfterMs);
            return { type: "retry" };
          }
        }
        if (TRANSIENT_SERVER_ERROR_STATUS_CODES.includes(response.status)) {
          const delayMs = getServerErrorRetryDelay(
            serverErrorRetryCount,
            response.headers.get("Retry-After"),
            serverErrorRetries,
          );
          if (delayMs !== undefined) {
            console.log(formatServerErrorRetry(requestUrl, response.status, delayMs));
            incrementMetric("serverErrorRetries");
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
        currentMethod = getRedirectMethod(result.status, currentMethod);
        break;
    }
  }
};
