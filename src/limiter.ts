import pLimit, { type LimitFunction } from "p-limit";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** An item whose processing threw, with what was thrown */
export type ConcurrentError<T> = { item: T; error: unknown };

/** Default per-host concurrency (`--host-concurrency` / `LINK_CHECK_HOST_CONCURRENCY`) */
export const DEFAULT_HOST_CONCURRENCY = 8;

/**
 * Parses a host concurrency value (positive integer, default `DEFAULT_HOST_CONCURRENCY`): the maximum number of
 * concurrent `fetch` requests to a single host.
 * @throws {Error} if the value is not a positive integer
 */
export const parseHostConcurrency = (value: string | undefined): number => {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_HOST_CONCURRENCY;
  }
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Invalid LINK_CHECK_HOST_CONCURRENCY "${value}", expected a positive integer.`);
  }
  return limit;
};

type HostState = { limit: LimitFunction; pausedUntil: number };

/** Waits until the pause of the host ends (a pause can be extended while waiting) */
const waitForPause = async (state: HostState) => {
  while (state.pausedUntil > Date.now()) {
    await sleep(state.pausedUntil - Date.now());
  }
};

/**
 * Limits concurrent requests per hostname (one p-limit queue per host).
 * A host can also be paused (e.g. after a 429 with `Retry-After`), new requests to it wait until the pause ends.
 */
export class HostLimiter {
  private readonly hosts = new Map<string, HostState>();

  constructor(private readonly limitPerHost: number) {}

  private getHost(url: string): HostState | undefined {
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      // Invalid URL, the request itself will fail, no need to limit it
      return undefined;
    }
    let state = this.hosts.get(hostname);
    if (!state) {
      state = { limit: pLimit(this.limitPerHost), pausedUntil: 0 };
      this.hosts.set(hostname, state);
    }
    return state;
  }

  /** Runs `fn` once a slot for the URL's host is free (and the host is not paused) */
  async run<T>(url: string, fn: () => Promise<T>): Promise<T> {
    const state = this.getHost(url);
    if (!state) {
      return fn();
    }
    return state.limit(async () => {
      await waitForPause(state);
      return fn();
    });
  }

  /**
   * Waits until the URL's host is no longer paused, without taking a slot. For requests that are not limited per host
   * but should still back off (Playwright navigations).
   */
  async waitUntilResumed(url: string): Promise<void> {
    const state = this.getHost(url);
    if (state) {
      await waitForPause(state);
    }
  }

  /** Pauses new requests to the URL's host for `ms` milliseconds */
  pause(url: string, ms: number) {
    const state = this.getHost(url);
    if (state) {
      state.pausedUntil = Math.max(state.pausedUntil, Date.now() + ms);
    }
  }
}

/**
 * Parses the `Retry-After` header (delay in seconds or an HTTP date) into milliseconds.
 * Returns `undefined` if the header is missing or invalid.
 */
export const parseRetryAfter = (value: string | null, now = Date.now()): number | undefined => {
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

/**
 * Runs `work` and rejects with `message` if it does not settle within `ms` milliseconds.
 * - On timeout the signal passed to `work` is aborted, so work that supports it (Octokit, fetch) stops.
 * - Work that ignores the signal keeps running in the background, only the caller stops waiting.
 */
export const withTimeout = async <T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
  message: string,
): Promise<T> => {
  const controller = new AbortController();
  const timeoutError = new Error(message);
  const timer = setTimeout(() => controller.abort(timeoutError), ms);
  const timedOut = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(timeoutError), { once: true });
  });
  try {
    return await Promise.race([work(controller.signal), timedOut]);
  } finally {
    clearTimeout(timer);
  }
};
