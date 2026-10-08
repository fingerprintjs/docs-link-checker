import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
/**
 * State of a single link-check run (a CLI command or a standalone `checkLinks`) as Effect services:
 * metrics, in-memory cache, the shared browser and the per-host limiter (see `limiter.ts`).
 * `withRun` provides all of them (`RunLayer`) and logs the metrics at the end.
 * - https://effect.website/docs/requirements-management/services/
 * - https://effect.website/docs/requirements-management/layers/
 */
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  FiberId,
  Layer,
  Option,
  Ref,
  Scope,
} from "effect";
import { type Browser, chromium } from "playwright";
import { DEFAULT_HOST_CONCURRENCY, HostLimiter } from "./limiter";
import { BrowserLaunchError } from "./utils/errors";

export type RunConfig = {
  hostConcurrency?: number;
};

export type RunMetrics = {
  counters: Record<string, number>;
  phases: Array<{ name: string; ms: number }>;
};

/** Metric names used in the summary log */
const METRICS = {
  totalLinks: "Total links",
  uniqueUrls: "Unique URLs",
  uniquePages: "Unique pages (URLs without hash)",
  // Distinct page fetches of link checks (per URL without hash and method), whatever the number of links to the page
  uniquePagesFetched: "Unique pages fetched",
  // Every `fetch()` call: each redirect hop and retry counts
  httpRequests: "HTTP requests (incl. redirects and retries)",
  playwrightNavigations: "Playwright navigations",
  // Requests and navigations retried after a 502, 503 or 504 (included in the counts above)
  serverErrorRetries: "Retries after a server error (502, 503, 504)",
  // A hash still missing after the shared wait is set in the same page and waited for again (SPA tabs)
  playwrightHashFallbacks: "Playwright in-page hash retries",
  // A hash not found within HASH_WAIT_TIMEOUT after the load is waited for longer (late-rendered anchors)
  playwrightLongHashWaits: "Playwright long hash waits",
  browserLaunches: "Browser launches",
  // Every request sent by the Octokit client (all operations, pagination, retries), counted by a request hook
  githubApiRequests: "GitHub API requests",
  githubCacheHits: "GitHub API cache hits",
} as const;

export type MetricName = keyof typeof METRICS;

const formatMs = (ms: number) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;

const formatRunMetrics = (metrics: RunMetrics, totalMs?: number): string => {
  const lines = ["Run metrics:"];
  for (const [name, label] of Object.entries(METRICS)) {
    const value = metrics.counters[name];
    if (value !== undefined) {
      lines.push(`  ${label}: ${value}`);
    }
  }
  if (metrics.phases.length > 0) {
    lines.push("  Phases:");
    for (const phase of metrics.phases) {
      lines.push(`    ${phase.name}: ${formatMs(phase.ms)}`);
    }
  }
  if (totalMs !== undefined) {
    lines.push(`  Total: ${formatMs(totalMs)}`);
  }
  return lines.join("\n");
};

/** Counters and phase timings of the run, logged at its end */
export class Metrics extends Context.Tag("Metrics")<
  Metrics,
  {
    readonly increment: (name: MetricName, by?: number) => Effect.Effect<void>;
    readonly recordPhase: (name: string, ms: number) => Effect.Effect<void>;
    readonly snapshot: Effect.Effect<RunMetrics>;
  }
>() {
  static layer = Layer.effect(
    Metrics,
    Effect.suspend(() => makeMetrics),
  );
}

const makeMetrics = Effect.gen(function* () {
  const ref = yield* Ref.make<RunMetrics>({ counters: {}, phases: [] });
  return Metrics.of({
    increment: (name, by = 1) =>
      Ref.update(ref, (metrics) => ({
        ...metrics,
        counters: { ...metrics.counters, [name]: (metrics.counters[name] ?? 0) + by },
      })),
    recordPhase: (name, ms) =>
      Ref.update(ref, (metrics) => ({ ...metrics, phases: [...metrics.phases, { name, ms }] })),
    snapshot: Ref.get(ref),
  });
});

export const incrementMetric = (name: MetricName, by = 1) =>
  Effect.flatMap(Metrics, (metrics) => metrics.increment(name, by));

/** Runs `effect` and records its duration as a phase of the run (also when it fails) */
export const timePhase = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const metrics = yield* Metrics;
    const start = yield* Clock.currentTimeMillis;
    return yield* Effect.ensuring(
      effect,
      Effect.flatMap(Clock.currentTimeMillis, (end) => metrics.recordPhase(name, end - start)),
    );
  });

/** Results shared by everything in the run, by key (see `runCached`) */
export class RunCache extends Context.Tag("RunCache")<
  RunCache,
  Map<string, Deferred.Deferred<unknown, unknown>>
>() {
  static layer = Layer.sync(RunCache, () => new Map());
}

type RunCachedOptions<E> = {
  /** Should a failure be cached too? By default, failures are evicted so the next call retries. */
  cacheError?: (error: E) => boolean;
  onHit?: Effect.Effect<void>;
  onMiss?: Effect.Effect<void>;
};

/**
 * Memoizes `effect` by `key` for the run. Concurrent callers share one execution.
 * Keys are namespaced by the callers: a key must always be used with the same result type.
 */
export const runCached = <A, E, R>(
  key: string,
  effect: Effect.Effect<A, E, R>,
  options: RunCachedOptions<E> = {},
): Effect.Effect<A, E, R | RunCache> =>
  Effect.gen(function* () {
    const cache = yield* RunCache;
    const cached = cache.get(key);
    if (cached) {
      yield* options.onHit ?? Effect.void;
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the cache holds results of any type, a key always has the same type
      return yield* cached as Deferred.Deferred<A, E>;
    }
    // No yield between the lookup and `set`, so concurrent callers always find this entry
    const deferred = Deferred.unsafeMake<A, E>(FiberId.none);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
    cache.set(key, deferred as Deferred.Deferred<unknown, unknown>);
    yield* options.onMiss ?? Effect.void;
    return yield* Effect.onExit(effect, (exit) =>
      Effect.suspend(() => {
        const evict =
          Exit.isFailure(exit) &&
          !Option.exists(
            Cause.failureOption(exit.cause),
            (error) => options.cacheError?.(error) ?? false,
          );
        if (evict && cache.get(key) === deferred) {
          cache.delete(key);
        }
        return Deferred.done(deferred, exit);
      }),
    );
  });

const LAUNCH_OPTIONS = {
  // Potentially helps avoid some bot detection checks
  args: ["--disable-blink-features=AutomationControlled"],
};

const isMissingBrowserExecutable = (error: unknown) =>
  error instanceof Error && error.message.includes("Executable doesn't exist");

const installPlaywrightChromium = () => {
  console.log("Playwright Chromium is missing, installing...");
  // This package's `playwright` CLI, not a different version from `npx playwright`
  const cli = join(
    dirname(createRequire(import.meta.url).resolve("playwright/package.json")),
    "cli.js",
  );
  const result = spawnSync(process.execPath, [cli, "install", "chromium"], { stdio: "inherit" });
  if (result.status !== 0) {
    throw (
      result.error ??
      new Error(`playwright install chromium failed (exit ${String(result.status)})`)
    );
  }
};

const closeBrowser = (browser: Browser) => Effect.promise(() => browser.close().catch(() => {}));

/**
 * The browser shared by the Playwright checks of the run. Launched on first use, closed when the run ends
 * (also on failure or interruption).
 */
export class BrowserSlot extends Context.Tag("BrowserSlot")<
  BrowserSlot,
  {
    /** Concurrent callers share one launch. A failed launch is not remembered, the next call tries again. */
    readonly get: Effect.Effect<Browser, BrowserLaunchError>;
    /** Closes a crashed browser and forgets it, so the next `get` launches a new one */
    readonly discard: (browser: Browser) => Effect.Effect<void>;
  }
>() {
  static layer = Layer.scoped(
    BrowserSlot,
    Effect.gen(function* () {
      const runScope = yield* Effect.scope;
      const metrics = yield* Metrics;
      const current = yield* Ref.make<Option.Option<Browser>>(Option.none());
      const launchLock = yield* Effect.makeSemaphore(1);

      const launchOnce = Effect.zipRight(
        metrics.increment("browserLaunches"),
        Effect.tryPromise({
          try: () => chromium.launch({ headless: true, ...LAUNCH_OPTIONS }),
          catch: (error) => error,
        }),
      );

      // Installs the browser once if it is missing
      const launchWithInstall = launchOnce.pipe(
        Effect.catchIf(isMissingBrowserExecutable, () =>
          Effect.zipRight(
            Effect.try({ try: installPlaywrightChromium, catch: (error) => error }),
            launchOnce,
          ),
        ),
        Effect.mapError((cause) => new BrowserLaunchError({ cause })),
      );

      // Released with the run, not with the caller that happened to launch it
      const launch = Scope.extend(Effect.acquireRelease(launchWithInstall, closeBrowser), runScope);

      return {
        get: launchLock.withPermits(1)(
          Effect.flatMap(
            Ref.get(current),
            Option.match({
              onSome: Effect.succeed,
              onNone: () => Effect.tap(launch, (browser) => Ref.set(current, Option.some(browser))),
            }),
          ),
        ),
        discard: (browser) =>
          Effect.zipRight(
            Ref.update(
              current,
              Option.filter((known) => known !== browser),
            ),
            closeBrowser(browser),
          ),
      };
    }),
  );
}

/** Everything a run provides, requirements of the core effects */
export type RunServices = HostLimiter | Metrics | RunCache | BrowserSlot;

const runLayerWith = (config: RunConfig, metrics: Layer.Layer<Metrics>) =>
  Layer.mergeAll(
    HostLimiter.layer(config.hostConcurrency ?? DEFAULT_HOST_CONCURRENCY),
    RunCache.layer,
    BrowserSlot.layer,
  ).pipe(Layer.provideMerge(metrics));

/** All services of a run. Prefer `withRun`, which also logs the metrics. */
export const RunLayer = (config: RunConfig = {}) => runLayerWith(config, Metrics.layer);

/**
 * Runs `effect` as a link-check run: provides `RunLayer(config)`, closes the shared browser and logs the run metrics
 * at the end (also on failure).
 * Call it once, at the entry point: code inside just requires the services. A nested `withRun` starts a separate run.
 * ```ts
 * await Effect.runPromise(checkLinks(args).pipe(withRun({ hostConcurrency: 4 })));
 * ```
 */
export const withRun =
  (config: RunConfig = {}) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const start = yield* Clock.currentTimeMillis;
      const metrics = yield* makeMetrics;
      return yield* effect.pipe(
        Effect.provide(runLayerWith(config, Layer.succeed(Metrics, metrics))),
        // Provided layers are closed (browser included) before this runs
        Effect.ensuring(
          Effect.gen(function* () {
            const end = yield* Clock.currentTimeMillis;
            console.log(formatRunMetrics(yield* metrics.snapshot, end - start));
          }),
        ),
      );
    });
