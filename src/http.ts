/**
 * HTTP for link checks, shared by the fetch and the Playwright checks:
 * - `Fetch`: the only reference to `globalThis.fetch`, faked in tests, also given to Octokit
 * - `fetchLimited`: requests limited per host, with redirects and retries of 429 and 502, 503, 504
 * - `classifyStatus` and the server error helpers: one decision of what a status means and when to retry,
 *   so both check methods treat statuses the same way
 * - `USER_AGENT` and `TASK_TIMEOUT`
 *
 * The retry loop of `fetchLimited` is explicit instead of `Effect.retry`: the host pause must be set inside the
 * slot, before it is released, with a delay that depends on the attempt. A schedule computes the delay after the
 * slot is gone, so a queued request could start in between.
 */
import { Clock, Context, Duration, Effect, Layer, Option } from "effect";
import { FetchError, TooManyRedirects } from "./errors";
import { HostLimiter } from "./limiter";
import { Metrics } from "./metrics";
import type { LinkCheckResult } from "./types";

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export class Fetch extends Context.Tag("Fetch")<Fetch, FetchFn>() {
  static readonly layer: Layer.Layer<Fetch> = Layer.succeed(Fetch, globalThis.fetch);
}

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

/**
 * Parses the `Retry-After` header (delay in seconds or an HTTP date) into milliseconds.
 * Returns `undefined` if the header is missing or invalid. `now` is epoch ms.
 */
export const parseRetryAfter = (value: string | null, now: number): number | undefined => {
  if (value === null || value.trim() === "") {
    return undefined;
  }
  if (/^\d+$/.test(value.trim())) {
    return parseInt(value.trim(), 10) * 1000;
  }
  const date = Date.parse(value);
  if (Number.isNaN(date)) {
    return undefined;
  }
  return Math.max(0, date - now);
};

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
 * Decides if a request (or navigation) that got a 502, 503 or 504 is retried. If so, logs it, counts it and returns
 * the delay to wait; `None` to give up: after `MAX_SERVER_ERROR_RETRIES` retries, or when `Retry-After` asks for
 * more than `MAX_SERVER_ERROR_RETRY_DELAY`. A `Retry-After` is respected (never retried sooner), the backoff is
 * the minimum.
 * @param retries retries done so far
 */
export const planServerErrorRetry = (args: {
  readonly url: string;
  readonly status: number;
  readonly retries: number;
  readonly retryAfter: string | null;
}): Effect.Effect<Option.Option<number>, never, Metrics> =>
  Effect.gen(function* () {
    if (args.retries >= MAX_SERVER_ERROR_RETRIES) {
      return Option.none();
    }
    const now = yield* Clock.currentTimeMillis;
    const backoff =
      SERVER_ERROR_RETRY_DELAYS[Math.min(args.retries, SERVER_ERROR_RETRY_DELAYS.length - 1)] ?? 0;
    const retryAfterMs = parseRetryAfter(args.retryAfter, now);
    if (retryAfterMs !== undefined && retryAfterMs > MAX_SERVER_ERROR_RETRY_DELAY) {
      return Option.none();
    }
    const delayMs = Math.min(Math.max(backoff, retryAfterMs ?? 0), MAX_SERVER_ERROR_RETRY_DELAY);
    yield* Effect.logInfo(
      `Server error ${args.status} (${args.url}), retrying after ${Math.ceil(delayMs / 1000)}s...`,
    );
    yield* (yield* Metrics).increment("serverErrorRetries");
    return Option.some(delayMs);
  });

/** Result for a 502, 503 or 504 that persisted after the retries: it says nothing about the link */
export const serverErrorResult = (status: number, statusText: string): LinkCheckResult => ({
  ok: false,
  error: "could not check",
  status,
  errorDetail: `Server error ${status}${statusText ? ` ${statusText}` : ""} (overloaded or rate limiting), still failing after up to ${MAX_SERVER_ERROR_RETRIES} retries`,
});

// Redirects followed per request (like `fetch`, which gives up after 20; 10 is plenty for real links)
const MAX_REDIRECTS = 10;

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

type LimitedResponse<T> = {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  /** Final URL, after redirects (like `Response.url`) */
  readonly url: string;
  /** What `read` returned for the final response */
  readonly data: T;
};

export type LimitedRequestOptions = {
  /** Default `GET`, kept across redirects */
  readonly method?: "GET" | "HEAD";
  readonly headers?: HeadersInit;
  /** Timeout of each request (each redirect hop), default `FETCH_TIMEOUT` */
  readonly timeoutMs?: number;
};

type HopResult<T> =
  | { readonly type: "rate-limit-retry" }
  | { readonly type: "server-error-retry" }
  | { readonly type: "redirect"; readonly location: string }
  | { readonly type: "final"; readonly response: Omit<LimitedResponse<T>, "url"> };

/** Cancels the response body if it was not consumed (frees the connection) */
const discardBody = (response: Response) =>
  Effect.promise(async () => {
    if (!response.bodyUsed) {
      await response.body?.cancel().catch(() => {});
    }
  });

/**
 * Sends a request limited per host (`HostLimiter`):
 * - Redirects are followed manually (at most `MAX_REDIRECTS`), every hop waits for a slot of *its* host, so requests
 *   redirected from many hosts to the same destination still respect the destination's limit.
 * - A 429 with a usable `Retry-After` pauses the whole host *before* the slot is released (so no queued request to
 *   that host starts during the pause), then the request is retried, at most `MAX_RATE_LIMIT_RETRIES` times.
 * - A 502, 503 or 504 is retried too (at most `MAX_SERVER_ERROR_RETRIES` times), after a backoff or the
 *   `Retry-After` delay (see `planServerErrorRetry`). The host is paused in the same way, so concurrent requests to
 *   an overloaded host back off as well.
 * - The final response (possibly still a 429 or 5xx) is returned. `read` consumes what it needs of the body inside
 *   the slot, any unread body (also of redirect and 429 responses) is cancelled before the slot is released.
 * - Each hop has a timeout that covers headers and body, interrupting the effect aborts the request.
 */
export const fetchLimited = Effect.fn("http.fetchLimited")(function* <T>(
  url: string,
  { method = "GET", headers, timeoutMs = FETCH_TIMEOUT }: LimitedRequestOptions,
  read: (response: Response) => Promise<T>,
) {
  const fetch = yield* Fetch;
  const limiter = yield* HostLimiter;
  const metrics = yield* Metrics;

  // Decides what to do with the response of one hop, inside the slot
  const handle = (
    response: Response,
    requestUrl: string,
    retries: { readonly rateLimit: number; readonly serverError: number },
  ): Effect.Effect<HopResult<T>, FetchError, Metrics> =>
    Effect.gen(function* () {
      const location = response.headers.get("Location");
      // An empty Location is a valid (relative) target, it resolves to the current URL
      if (REDIRECT_STATUS_CODES.has(response.status) && location !== null) {
        return { type: "redirect", location };
      }
      if (response.status === 429 && retries.rateLimit < MAX_RATE_LIMIT_RETRIES) {
        const retryAfter = response.headers.get("Retry-After");
        const retryAfterMs = parseRetryAfter(retryAfter, yield* Clock.currentTimeMillis);
        if (retryAfterMs !== undefined && retryAfterMs < TASK_TIMEOUT) {
          // Retry-After is either a number of seconds or an HTTP date, log the parsed delay
          yield* Effect.logInfo(
            `Rate limited (${requestUrl}), retrying after ${Math.ceil(retryAfterMs / 1000)}s (Retry-After: ${retryAfter})...`,
          );
          // Pause the whole host while still holding the slot
          yield* limiter.pause(requestUrl, retryAfterMs);
          return { type: "rate-limit-retry" };
        }
      }
      if (classifyStatus(response.status) === "server-error") {
        const delayMs = yield* planServerErrorRetry({
          url: requestUrl,
          status: response.status,
          retries: retries.serverError,
          retryAfter: response.headers.get("Retry-After"),
        });
        if (Option.isSome(delayMs)) {
          // Like a 429: the whole host backs off while the slot is still held
          yield* limiter.pause(requestUrl, delayMs.value);
          return { type: "server-error-retry" };
        }
      }
      const data = yield* Effect.tryPromise({
        try: () => read(response),
        catch: (cause) => new FetchError({ url: requestUrl, cause }),
      });
      return {
        type: "final",
        response: {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
          data,
        },
      };
    });

  const hop = (
    requestUrl: string,
    retries: { readonly rateLimit: number; readonly serverError: number },
  ) =>
    Effect.gen(function* () {
      // Counted per actual request (every redirect hop and retry)
      yield* metrics.increment("httpRequests");
      const response = yield* Effect.tryPromise({
        try: (signal) => fetch(requestUrl, { method, headers, redirect: "manual", signal }),
        catch: (cause) => new FetchError({ url: requestUrl, cause }),
      });
      return yield* handle(response, requestUrl, retries).pipe(
        // Whatever was not consumed is cancelled before the slot is released,
        // so no response stream stays active outside the per-host limit
        Effect.ensuring(discardBody(response)),
      );
    }).pipe(
      Effect.timeoutFail({
        duration: Duration.millis(timeoutMs),
        onTimeout: () =>
          new FetchError({
            url: requestUrl,
            // Same text as `AbortSignal.timeout`, so reports do not change
            cause: new DOMException("The operation was aborted due to timeout", "TimeoutError"),
          }),
      }),
    );

  let currentUrl = url;
  let redirects = 0;
  const retries = { rateLimit: 0, serverError: 0 };

  for (;;) {
    const result = yield* limiter.withSlot(currentUrl, hop(currentUrl, { ...retries }));
    switch (result.type) {
      case "final":
        return { ...result.response, url: currentUrl } satisfies LimitedResponse<T>;
      case "rate-limit-retry":
        retries.rateLimit++;
        break;
      case "server-error-retry":
        retries.serverError++;
        break;
      case "redirect":
        if (redirects >= MAX_REDIRECTS) {
          return yield* new TooManyRedirects({ url, maxRedirects: MAX_REDIRECTS });
        }
        redirects++;
        currentUrl = new URL(result.location, currentUrl).href;
        break;
    }
  }
});
