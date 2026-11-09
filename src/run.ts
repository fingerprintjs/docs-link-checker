import { AsyncLocalStorage } from "node:async_hooks";
import pLimit, { type LimitFunction } from "p-limit";
import type { Browser, BrowserType } from "playwright";
import type { GithubApi } from "./github/client";
import { createSilentTerminal, formatDuration, type Terminal } from "./terminal";
import { DEFAULT_HOST_CONCURRENCY, HostLimiter } from "./utils/limiter";

// How many Playwright pages (browser contexts) are open at the same time
export const PLAYWRIGHT_CONCURRENCY_LIMIT = 5;

/**
 * External dependencies of a run. Production code uses the real ones when a field is unset,
 * tests pass small fakes here instead of mocking modules.
 */
export type RunDeps = {
  fetch?: typeof fetch;
  /** Replaces the shared Octokit client (see `getGithubApi`) */
  octokit?: () => GithubApi;
  chromium?: Pick<BrowserType, "launch">;
  /** Installs the missing Playwright Chromium */
  installChromium?: () => void;
};

export type RunConfig = {
  hostConcurrency?: number;
  deps?: RunDeps;
  /** Where steps, progress and verbose details are shown. Defaults to a terminal that prints nothing. */
  terminal?: Terminal;
};

type BrowserSlot = { promise?: Promise<Browser>; browser?: Browser };

/**
 * State of a single link-check run (a CLI command or a standalone `checkLinks`):
 * in-memory caches, metrics, the per-host limiter, the shared browser and its page slots.
 */
export type RunContext = {
  deps: RunDeps;
  cache: Map<string, CacheEntry>;
  metrics: RunMetrics;
  terminal: Terminal;
  hostLimiter: HostLimiter;
  browser: BrowserSlot;
  pageSlots: LimitFunction;
};

export type RunMetrics = {
  counters: Record<string, number>;
  phases: Array<{ name: string; ms: number }>;
};

const createRunContext = (config: RunConfig = {}): RunContext => ({
  deps: config.deps ?? {},
  cache: new Map(),
  metrics: { counters: {}, phases: [] },
  terminal: config.terminal ?? createSilentTerminal(),
  hostLimiter: new HostLimiter(config.hostConcurrency ?? DEFAULT_HOST_CONCURRENCY),
  browser: {},
  pageSlots: pLimit(PLAYWRIGHT_CONCURRENCY_LIMIT),
});

const storage = new AsyncLocalStorage<RunContext>();

/** The context of the current run, `undefined` outside of `withRun` (metrics and caching are no-ops there) */
export const getRunContext = (): RunContext | undefined => storage.getStore();

// Used outside of any run (e.g. integration tests calling fetchWithHostLimit or checkUrlsOnPageWithPlaywright directly):
// a single lazily created context with defaults, so there is still one host limiter and browser.
let defaultContext: RunContext | undefined;
const getContext = (): RunContext => getRunContext() ?? (defaultContext ??= createRunContext());

/** Injected dependencies of the current run (or the default context outside of any run) */
export const getDeps = (): RunDeps => getContext().deps;

/** Terminal of the current run (or the default context outside of any run) */
export const getTerminal = (): Terminal => getContext().terminal;

/** The per-host limiter of the current run (or the default context outside of any run) */
export const getHostLimiter = (): HostLimiter => getContext().hostLimiter;

/** Slot holding the shared browser of the current run (or the default context), see `src/browser.ts` */
export const getBrowserSlot = (): BrowserSlot => getContext().browser;

/** Limits open Playwright pages of the current run (or the default context), see `withPage` in `src/browser.ts` */
export const getPageSlots = (): LimitFunction => getContext().pageSlots;

const closeContextBrowser = async (slot: BrowserSlot): Promise<void> => {
  const promise = slot.promise;
  slot.promise = undefined;
  slot.browser = undefined;
  if (!promise) {
    return;
  }
  try {
    const browser = await promise;
    await browser.close();
  } catch {
    // Launch failed or the browser is already gone
  }
};

/**
 * Closes the shared browser of the current run (or the default context). Safe to call multiple times.
 * Standalone checks outside of a run (tests) call it themselves, runs close their own browser at the end (`withRun`).
 */
export const closeRunBrowser = (): Promise<void> => closeContextBrowser(getContext().browser);

/**
 * Runs `fn` as a link-check run: in-memory caches (GitHub API responses...) and metrics live for the duration of the
 * run, requests use a dedicated per-host limiter (`config.hostConcurrency`, default 8). At the end (also on
 * errors), the run metrics are shown (with --verbose) and the shared browser (if one was launched) is closed.
 * Nested calls (e.g. `checkLinks` inside `checkWebsite`) join the outer run, its config applies to all of it.
 */
export const withRun = async <T>(config: RunConfig, fn: () => Promise<T>): Promise<T> => {
  if (getRunContext()) {
    return fn();
  }
  const context = createRunContext(config);
  return storage.run(context, async () => {
    const startTime = performance.now();
    try {
      return await fn();
    } finally {
      await closeContextBrowser(context.browser);
      context.terminal.clear();
      context.terminal.verbose(formatRunMetrics(context.metrics, performance.now() - startTime));
    }
  });
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

export const incrementMetric = (name: MetricName, by = 1) => {
  const metrics = getRunContext()?.metrics;
  if (metrics) {
    metrics.counters[name] = (metrics.counters[name] ?? 0) + by;
  }
};

/** Runs `fn` and records its duration as a phase of the current run */
export const timePhase = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    getRunContext()?.metrics.phases.push({ name, ms: performance.now() - start });
  }
};

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
      lines.push(`    ${phase.name}: ${formatDuration(phase.ms)}`);
    }
  }
  if (totalMs !== undefined) {
    lines.push(`  Total: ${formatDuration(totalMs)}`);
  }
  return lines.join("\n");
};

/** Shared work of `runCached`, aborted when every caller waiting for it gave up */
type CacheEntry = {
  promise: Promise<unknown>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
};

type RunCachedOptions = {
  /** Should a rejection be cached too? By default, rejections are evicted so the next call retries. */
  cacheError?: (error: unknown) => boolean;
  /** Stops waiting for this caller (see `runCached`) */
  signal?: AbortSignal;
  onHit?: () => void;
};

/**
 * Memoizes `fn` by `key` for the current run. Concurrent callers share the same work.
 * - An already aborted `signal` fails before any work (no new request after a timeout).
 * - A later abort stops only this caller. The signal passed to `fn` aborts once all callers aborted: work nobody waits
 *   for is stopped and evicted, the next call starts it again.
 * Outside of a run, `fn` is called every time with the caller's signal.
 */
export const runCached = async <T>(
  key: string,
  fn: (signal: AbortSignal) => Promise<T>,
  { cacheError, signal, onHit }: RunCachedOptions = {},
): Promise<T> => {
  signal?.throwIfAborted();
  const context = getRunContext();
  if (!context) {
    return fn(signal ?? new AbortController().signal);
  }
  let entry = context.cache.get(key);
  if (entry) {
    onHit?.();
  } else {
    const controller = new AbortController();
    const created: CacheEntry = {
      promise: Promise.resolve(),
      controller,
      waiters: 0,
      settled: false,
    };
    // Settled before any caller sees the result, so a caller leaving after it never aborts finished work
    created.promise = fn(controller.signal).finally(() => {
      created.settled = true;
    });
    created.promise.catch((error: unknown) => {
      if (!cacheError?.(error) && context.cache.get(key) === created) {
        context.cache.delete(key);
      }
    });
    context.cache.set(key, created);
    entry = created;
  }
  entry.waiters++;
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the cache holds work of any type, keys are namespaced by the callers so a key always has the same type
    return (await abortable(entry.promise, signal)) as T;
  } finally {
    entry.waiters--;
    if (entry.waiters === 0 && !entry.settled) {
      entry.controller.abort(signal?.reason);
      if (context.cache.get(key) === entry) {
        context.cache.delete(key);
      }
    }
  }
};

/** Waits for `promise` until `signal` aborts. The promise itself keeps running. */
const abortable = async <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) {
    return promise;
  }
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};
