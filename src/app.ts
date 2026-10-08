/**
 * Layer wiring of a link check run. A run is a CLI command or a bench round: it gets fresh metrics, per-host
 * limits, GitHub caches and a lazily launched browser, all closed at the end. No module-level state.
 */
import { Effect, Layer } from "effect";
import { Browser, Chromium } from "./browser";
import { DEFAULT_HOST_CONCURRENCY } from "./config";
import { GitHub } from "./github/github_client";
import { Fetch } from "./http";
import { HostLimiter } from "./limiter";
import { LogLayer } from "./logger";
import { Metrics } from "./metrics";

export type RunSettings = { readonly hostConcurrency: number };

/** Everything a link check needs. `Chromium` is internal to `Browser.layer`. */
export type RunServices = Fetch | Metrics | HostLimiter | GitHub | Browser;

/**
 * `Metrics` is built first, so it is closed last and its summary is logged after the browser closed.
 */
export const liveRunLayer = (settings: RunSettings): Layer.Layer<RunServices> =>
  Layer.mergeAll(HostLimiter.layer(settings.hostConcurrency), GitHub.layer, Browser.layer).pipe(
    Layer.provideMerge(Layer.mergeAll(Metrics.layer, Fetch.layer, Chromium.layer)),
  );

/** For scripts (bench, checks): plain logs, one run */
export const runLive = <A, E>(
  effect: Effect.Effect<A, E, RunServices>,
  settings: RunSettings = { hostConcurrency: DEFAULT_HOST_CONCURRENCY },
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.provide(liveRunLayer(settings)), Effect.provide(LogLayer({ json: false }))),
  );
