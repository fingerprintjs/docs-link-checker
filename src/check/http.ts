/**
 * HTTP for link checks, shared by the fetch and the Playwright checks:
 * - `fetchWithHostLimit`: requests limited per host, with redirects and retries (see `planRetry`)
 * - `pauseHostForRetry`: the host back-off before a retry, same for requests and Playwright navigations
 * - `USER_AGENT`, `getUserAgent` and `getRedirectTarget`
 */
import { getDeps, getHostLimiter, getTerminal, incrementMetric } from "../run";
import { stripHash } from "./hash";
import { planRetry, type RetryPlan } from "./verdict";

// Timeout of a single fetch request
const FETCH_TIMEOUT = 20000;

// Desktop Chrome user agent, some websites refuse requests from unknown clients.
// One fixed value (not rotated) so runs are repeatable. Update the Chrome version now and then.
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/** `USER_AGENT`, or `undefined` for sites that block you when the user agent is spoofed (android.com) */
export const getUserAgent = (url: string): string | undefined =>
  url.includes("android.com") ? undefined : USER_AGENT;

/**
 * Pauses the host of `url` for a planned retry and logs it. Called while the request still holds its host slot, so
 * no queued request to that host starts during the pause (concurrent requests to an overloaded host back off too).
 * @param retryAfter raw `Retry-After` header, for the log
 */
export const pauseHostForRetry = (
  url: string,
  status: number,
  retryAfter: string | null,
  { reason, delayMs }: RetryPlan,
) => {
  const seconds = Math.ceil(delayMs / 1000);
  if (reason === "rate-limited") {
    // Retry-After is either a number of seconds or an HTTP date, log the parsed delay
    getTerminal().verbose(
      `Rate limited (${url}), retrying after ${seconds}s (Retry-After: ${retryAfter})...`,
    );
  } else {
    getTerminal().verbose(`Server error ${status} (${url}), retrying after ${seconds}s...`);
    incrementMetric("serverErrorRetries");
  }
  getHostLimiter().pause(url, delayMs);
};

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

/** Cancels the response body if it was not consumed (frees the connection) */
const discardBody = async (response: Response) => {
  if (!response.bodyUsed) {
    await response.body?.cancel().catch(() => {});
  }
};

type HopResult<T> =
  | { type: "retry"; plan: RetryPlan }
  | { type: "redirect"; location: string }
  | { type: "final"; response: Omit<LimitedResponse<T>, "url"> };

/**
 * Sends a request limited per host (see `getHostLimiter`):
 * - Redirects are followed manually (at most `MAX_REDIRECTS`), every hop waits for a slot of *its* host, so requests
 *   redirected from many hosts to the same destination still respect the destination's limit.
 * - A 429 with a usable `Retry-After` and a 502, 503 or 504 are retried (see `planRetry`). The whole host is paused
 *   *before* the slot is released (see `pauseHostForRetry`).
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
  const retries = { "rate-limited": 0, "server-error": 0 };

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
        const retryAfter = response.headers.get("Retry-After");
        const plan = planRetry("fetch", { status: response.status, retryAfter }, retries);
        if (plan) {
          pauseHostForRetry(requestUrl, response.status, retryAfter, plan);
          return { type: "retry", plan };
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
        retries[result.plan.reason]++;
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
