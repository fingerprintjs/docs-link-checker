import { parseRetryAfter } from "./limiter";
import { incrementMetric } from "./run_context";
import { FETCH_TIMEOUT, getHostLimiter, TASK_TIMEOUT } from "./utils";

// How many times a request is retried after a 429 with `Retry-After`
export const MAX_RATE_LIMIT_RETRIES = 2;
// Redirects followed per request (like `fetch`, which gives up after 20; 10 is plenty for real links)
export const MAX_REDIRECTS = 10;

const REDIRECT_STATUS_CODES = [301, 302, 303, 307, 308];

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
};

/** Log message for a rate-limited request that is retried (the header can be seconds or an HTTP date) */
export const formatRateLimitRetry = (url: string, delayMs: number, retryAfter: string | null) =>
  `Rate limited (${url}), retrying after ${Math.ceil(delayMs / 1000)}s (Retry-After: ${retryAfter})...`;

/** Cancels the response body if it was not consumed (frees the connection) */
export const discardBody = async (response: Response) => {
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
  | { type: "redirect"; location: string; status: number }
  | { type: "final"; response: Omit<LimitedResponse<T>, "url"> };

/**
 * Sends a request limited per host (see `getHostLimiter`):
 * - Redirects are followed manually (at most `MAX_REDIRECTS`), every hop waits for a slot of *its* host, so requests
 *   redirected from many hosts to the same destination still respect the destination's limit.
 * - A 429 with a usable `Retry-After` pauses the whole host *before* the slot is released (so no queued request to
 *   that host starts during the pause), then the request is retried, at most `MAX_RATE_LIMIT_RETRIES` times.
 * - The final response (possibly still a 429) is returned. `read` consumes what it needs of the body inside the slot,
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
  let currentMethod = method;
  let redirects = 0;
  let rateLimitRetries = 0;

  for (;;) {
    const requestUrl = currentUrl;
    const requestMethod = currentMethod;
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
        if (REDIRECT_STATUS_CODES.includes(response.status) && location !== null) {
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
