// TODO(effect): remove this whole file once its callers are Effects.
// Every caller is marked `// TODO(effect): convert`.
// Promise API of the Effect core (`run.ts`, `http.ts`, `limiter.ts`) for code that is not converted yet.
// - Inside `withRun` the services of the run are kept in AsyncLocalStorage, outside of it a default run is used.
// - Failures are rethrown as the original error (not as a `FiberFailure`), like the Promise code expects.
import { AsyncLocalStorage } from "node:async_hooks";
import { Cause, Context, Effect, Exit, ManagedRuntime } from "effect";
import { GitHubClient } from "./github/github_client";
import {
  fetchWithHostLimit as fetchWithHostLimitEffect,
  type LimitedRequestOptions,
  planServerErrorRetry as planServerErrorRetryEffect,
} from "./http";
import { HostLimiter } from "./limiter";
import {
  incrementMetric as incrementMetricEffect,
  Metrics,
  type MetricName,
  type RunConfig,
  RunLayer,
  type RunMetrics,
  type RunServices,
  runCached as runCachedEffect,
  timePhase as timePhaseEffect,
  withRun as withRunEffect,
} from "./run";

type Services = Context.Context<RunServices | GitHubClient>;

/** Host limiter with the API of the old class: Promises and a synchronous `pause` */
type PromiseHostLimiter = {
  readonly limitPerHost: number;
  run: <T>(url: string, fn: () => Promise<T>) => Promise<T>;
  waitUntilResumed: (url: string) => Promise<void>;
  pause: (url: string, ms: number) => void;
};

type Store = { services: Services; hostLimiter: PromiseHostLimiter };

// `immediate`: start running synchronously, like the Promise code this replaces (tests with fake timers rely on it)
const toPromise = async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
  const fiber = Effect.runFork(effect, { immediate: true });
  const exit = await new Promise<Exit.Exit<A, E>>((resolve) => fiber.addObserver(resolve));
  if (Exit.isFailure(exit)) {
    throw Cause.squash(exit.cause);
  }
  return exit.value;
};

const makeStore = (runServices: Context.Context<RunServices>): Store => {
  const limiter = Effect.runSync(Effect.provide(HostLimiter, runServices));
  // One GitHub client per run, like a `GitHubClient.layer` provided to the run
  const github = Effect.runSync(Effect.provide(GitHubClient.effect, runServices));
  return {
    services: Context.add(runServices, GitHubClient, github),
    hostLimiter: {
      limitPerHost: limiter.limitPerHost,
      run: (url, fn) => toPromise(limiter.run(url, Effect.promise(fn))),
      waitUntilResumed: (url) => toPromise(limiter.waitUntilResumed(url)),
      pause: (url, ms) => Effect.runSync(limiter.pause(url, ms)),
    },
  };
};

const storage = new AsyncLocalStorage<Store>();

// Used outside of any run (unit tests calling a single check): one lazily created run with defaults
let defaultRun:
  | { runtime: ManagedRuntime.ManagedRuntime<RunServices, never>; store: Store }
  | undefined;

const getDefaultStore = (): Store => {
  if (!defaultRun) {
    const runtime = ManagedRuntime.make(RunLayer());
    defaultRun = { runtime, store: makeStore(runtime.runSync(Effect.context<RunServices>())) };
  }
  return defaultRun.store;
};

const getStore = (): Store => storage.getStore() ?? getDefaultStore();

/** Runs an Effect of the core with the services of the current run (or the default one) */
export const runEffect = <A, E>(
  effect: Effect.Effect<A, E, RunServices | GitHubClient>,
): Promise<A> => toPromise(Effect.provide(effect, getStore().services));

/**
 * Runs `fn` as a run (see `withRun` in `run.ts`). Nested calls join the outer run.
 */
export const withRun = async <T>(config: RunConfig, fn: () => Promise<T>): Promise<T> => {
  if (storage.getStore()) {
    return fn();
  }
  return toPromise(
    withRunEffect(config)(
      Effect.gen(function* () {
        const store = makeStore(yield* Effect.context<RunServices>());
        return yield* Effect.promise(() => storage.run(store, fn));
      }),
    ),
  );
};

/** The metrics of the current run, `undefined` outside of `withRun` */
export const getRunContext = (): { readonly metrics: RunMetrics } | undefined => {
  const store = storage.getStore();
  return (
    store && {
      metrics: Effect.runSync(
        Effect.flatMap(Metrics, (m) => m.snapshot).pipe(Effect.provide(store.services)),
      ),
    }
  );
};

/** The limiter of the current run (or the default one outside of any run) */
export const getHostLimiter = (): PromiseHostLimiter => getStore().hostLimiter;

/** Closes the browser of the default run (standalone checks outside of `withRun`). Runs close their own browser. */
export const closeRunBrowser = async (): Promise<void> => {
  const run = defaultRun;
  defaultRun = undefined;
  await run?.runtime.dispose();
};

/** Does nothing outside of a run */
export const incrementMetric = (name: MetricName, by = 1) => {
  const store = storage.getStore();
  if (store) {
    Effect.runSync(Effect.provide(incrementMetricEffect(name, by), store.services));
  }
};

export const timePhase = <T>(name: string, fn: () => Promise<T>): Promise<T> =>
  storage.getStore() ? runEffect(timePhaseEffect(name, Effect.promise(fn))) : fn();

/** Calls `fn` every time outside of a run */
export const runCached = <T>(
  key: string,
  fn: () => Promise<T>,
  options: {
    cacheError?: (error: unknown) => boolean;
    onHit?: () => void;
    onMiss?: () => void;
  } = {},
): Promise<T> =>
  storage.getStore()
    ? runEffect(
        runCachedEffect(key, Effect.tryPromise({ try: fn, catch: (error) => error }), {
          cacheError: options.cacheError,
          onHit: options.onHit && Effect.sync(options.onHit),
          onMiss: options.onMiss && Effect.sync(options.onMiss),
        }),
      )
    : fn();

export const fetchWithHostLimit = <T>(
  url: string,
  options: LimitedRequestOptions,
  read: (response: Response) => Promise<T>,
) =>
  runEffect(
    fetchWithHostLimitEffect(url, options, (response) =>
      Effect.tryPromise({ try: () => read(response), catch: (error) => error }),
    ),
  );

/** Rejects if `promise` does not settle in time (the underlying work is not cancelled) */
export const withTimeout = <T>(promise: Promise<T>, ms: number, message: string): Promise<T> =>
  toPromise(
    Effect.tryPromise({ try: () => promise, catch: (error) => error }).pipe(
      Effect.timeoutFail({ duration: ms, onTimeout: () => new Error(message) }),
    ),
  );

/** Sync like the old API: it only logs and counts, the decision is pure */
export const planServerErrorRetry = (
  url: string,
  status: number,
  retries: number,
  retryAfter: string | null,
): number | undefined =>
  Effect.runSync(
    Effect.provide(
      planServerErrorRetryEffect(url, status, retries, retryAfter),
      getStore().services,
    ),
  );
