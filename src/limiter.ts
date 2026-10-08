// Per-host request limits, see https://effect.website/docs/concurrency/semaphore/
import { Clock, Context, Effect, Layer } from "effect";

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

type HostState = { semaphore: Effect.Semaphore; pausedUntil: number };

/**
 * Per-host concurrency limit and pause (service, one semaphore per hostname).
 * A host can be paused (e.g. after a 429 with `Retry-After`), new requests to it wait until the pause ends.
 * Time comes from `Clock`, so tests can control it.
 */
export class HostLimiter extends Context.Tag("HostLimiter")<
  HostLimiter,
  {
    readonly limitPerHost: number;
    /** Runs `effect` once a slot for the URL's host is free (and the host is not paused). Interruption frees the slot. */
    readonly run: <A, E, R>(url: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    /**
     * Waits until the URL's host is no longer paused, without taking a slot. For requests that are not limited per
     * host but should still back off (Playwright navigations).
     */
    readonly waitUntilResumed: (url: string) => Effect.Effect<void>;
    /** Pauses new requests to the URL's host for `ms` milliseconds */
    readonly pause: (url: string, ms: number) => Effect.Effect<void>;
  }
>() {
  static layer = (limitPerHost: number) =>
    Layer.sync(HostLimiter, () => makeHostLimiter(limitPerHost));
}

const makeHostLimiter = (limitPerHost: number): Context.Tag.Service<HostLimiter> => {
  const hosts = new Map<string, HostState>();

  const getHost = (url: string): HostState | undefined => {
    const hostname = URL.canParse(url) ? new URL(url).hostname : undefined;
    // Invalid URL, the request itself will fail, no need to limit it
    if (hostname === undefined) {
      return undefined;
    }
    let state = hosts.get(hostname);
    if (!state) {
      state = { semaphore: Effect.unsafeMakeSemaphore(limitPerHost), pausedUntil: 0 };
      hosts.set(hostname, state);
    }
    return state;
  };

  // A pause can be extended while waiting, so check again after each sleep
  const waitForPause = (state: HostState) =>
    Effect.gen(function* () {
      for (;;) {
        const now = yield* Clock.currentTimeMillis;
        if (state.pausedUntil <= now) {
          return;
        }
        yield* Effect.sleep(state.pausedUntil - now);
      }
    });

  return {
    limitPerHost,
    run: (url, effect) => {
      const state = getHost(url);
      return state
        ? state.semaphore.withPermits(1)(Effect.zipRight(waitForPause(state), effect))
        : effect;
    },
    waitUntilResumed: (url) => {
      const state = getHost(url);
      return state ? waitForPause(state) : Effect.void;
    },
    pause: (url, ms) =>
      Effect.gen(function* () {
        const state = getHost(url);
        if (state) {
          state.pausedUntil = Math.max(state.pausedUntil, (yield* Clock.currentTimeMillis) + ms);
        }
      }),
  };
};

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
