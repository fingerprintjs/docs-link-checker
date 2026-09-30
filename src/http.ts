import { parseRetryAfter } from "./limiter";
import { incrementMetric } from "./run_context";
import { getHostLimiter, TASK_TIMEOUT } from "./utils";

// How many times a request is retried after a 429 with `Retry-After`
export const MAX_RATE_LIMIT_RETRIES = 2;

export type LimitedResponse<T> = {
  status: number;
  statusText: string;
  headers: Headers;
  /** What `read` returned for the final response */
  data: T;
};

const RETRY = Symbol("retry");

/** Cancels the response body if it was not consumed (frees the connection) */
export const discardBody = async (response: Response) => {
  if (!response.bodyUsed) {
    await response.body?.cancel().catch(() => {});
  }
};

/**
 * Sends a request limited per host (see `getHostLimiter`) and handles rate limiting:
 * a 429 with a usable `Retry-After` pauses the whole host *before* the slot is released (so no queued request to
 * that host starts during the pause), then the request is retried, at most `MAX_RATE_LIMIT_RETRIES` times.
 * The final response (possibly still a 429) is returned, `read` consumes its body inside the slot, any unread body
 * is cancelled before the slot is released. `request` must discard the bodies of intermediate responses itself
 * (e.g. a HEAD before a GET fallback, see `discardBody`).
 * @param url used for the per-host limit
 * @param request sends the request (can be several requests, e.g. HEAD with a GET fallback)
 * @param read reads what's needed from the final response (e.g. the body)
 */
export const fetchWithHostLimit = async <T>(
  url: string,
  request: () => Promise<Response>,
  read: (response: Response) => Promise<T>
): Promise<LimitedResponse<T>> => {
  const hostLimiter = getHostLimiter();
  for (let attempt = 0; ; attempt++) {
    const result = await hostLimiter.run(url, async () => {
      incrementMetric("pagesFetched");
      const response = await request();
      if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        const retryAfter = response.headers.get("Retry-After");
        const retryAfterMs = parseRetryAfter(retryAfter);
        if (retryAfterMs !== undefined && retryAfterMs < TASK_TIMEOUT) {
          console.log(`Rate limited, retrying after ${retryAfter} seconds...`);
          // Pause the whole host while still holding the slot
          hostLimiter.pause(url, retryAfterMs);
          await discardBody(response);
          return RETRY;
        }
      }
      try {
        return {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
          data: await read(response),
        };
      } finally {
        // Whatever `read` did not consume is cancelled before the slot is released,
        // so no response stream stays active outside the per-host limit
        await discardBody(response);
      }
    });
    if (result !== RETRY) {
      return result;
    }
  }
};
