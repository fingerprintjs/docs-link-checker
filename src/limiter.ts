/**
 * Per-host request limits. One semaphore per hostname caps concurrent requests, a host can also be paused
 * (after a 429 or 5xx with `Retry-After`) so queued requests to it wait.
 * - https://effect.website/docs/concurrency/semaphore/
 */
import { Clock, Context, Effect, Layer, Ref } from "effect";

type HostState = {
  readonly semaphore: Effect.Semaphore;
  /** Epoch ms */
  readonly pausedUntil: Ref.Ref<number>;
};

export class HostLimiter extends Context.Tag("HostLimiter")<
  HostLimiter,
  {
    /**
     * Runs `effect` in a free slot of the URL's host, after the host pause ended (checked inside the slot, so
     * a pause set by a request that holds a slot applies to the queued ones). Unparsable URLs are not limited,
     * the request itself fails.
     */
    readonly withSlot: <A, E, R>(
      url: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    /** Waits until the host is not paused, without a slot (Playwright navigations) */
    readonly waitUntilResumed: (url: string) => Effect.Effect<void>;
    /** Pauses new requests to the host for `ms`, never shortens an existing pause */
    readonly pause: (url: string, ms: number) => Effect.Effect<void>;
  }
>() {
  static readonly layer = (hostConcurrency: number): Layer.Layer<HostLimiter> =>
    Layer.effect(
      HostLimiter,
      Effect.gen(function* () {
        const getHost = yield* Effect.cachedFunction(
          (_hostname: string): Effect.Effect<HostState> =>
            Effect.all({
              semaphore: Effect.makeSemaphore(hostConcurrency),
              pausedUntil: Ref.make(0),
            }),
        );

        const stateOf = (url: string): Effect.Effect<HostState | undefined> =>
          URL.canParse(url) ? getHost(new URL(url).hostname) : Effect.succeed(undefined);

        // A pause can be extended while waiting
        const waitForPause = (state: HostState): Effect.Effect<void> =>
          Effect.gen(function* () {
            for (;;) {
              const now = yield* Clock.currentTimeMillis;
              const until = yield* Ref.get(state.pausedUntil);
              if (until <= now) {
                return;
              }
              yield* Effect.sleep(until - now);
            }
          });

        return {
          withSlot: (url, effect) =>
            Effect.flatMap(stateOf(url), (state) =>
              state
                ? state.semaphore.withPermits(1)(Effect.zipRight(waitForPause(state), effect))
                : effect,
            ),
          waitUntilResumed: (url) =>
            Effect.flatMap(stateOf(url), (state) => (state ? waitForPause(state) : Effect.void)),
          pause: (url, ms) =>
            Effect.gen(function* () {
              const state = yield* stateOf(url);
              if (state) {
                const now = yield* Clock.currentTimeMillis;
                yield* Ref.update(state.pausedUntil, (until) => Math.max(until, now + ms));
              }
            }),
        };
      }),
    );
}
