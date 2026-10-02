import { AsyncLocalStorage } from "node:async_hooks";
import type { Browser } from "playwright";
import { DEFAULT_HOST_CONCURRENCY, HostLimiter } from "./limiter";

export type RunConfig = {
  hostConcurrency?: number;
  /** Allow requests to private and local addresses (SSRF guard off, see `src/destination.ts`) */
  allowPrivateHosts?: boolean;
};

type BrowserSlot = { promise?: Promise<Browser>; browser?: Browser };

/**
 * State of a single link-check run (`checkWebsite`, `checkReadmesInGithubOrg` or a standalone `checkLinks`):
 * in-memory caches, metrics, the per-host limiter, the SSRF guard setting and the shared browser.
 */
export type RunContext = {
  cache: Map<string, Promise<unknown>>;
  metrics: RunMetrics;
  hostLimiter: HostLimiter;
  allowPrivateHosts: boolean;
  browser: BrowserSlot;
};

export type RunMetrics = {
  counters: Record<string, number>;
  phases: Array<{ name: string; ms: number }>;
};

const createRunContext = (config: RunConfig = {}): RunContext => ({
  cache: new Map(),
  metrics: { counters: {}, phases: [] },
  hostLimiter: new HostLimiter(config.hostConcurrency ?? DEFAULT_HOST_CONCURRENCY),
  allowPrivateHosts: config.allowPrivateHosts ?? false,
  browser: {},
});

const storage = new AsyncLocalStorage<RunContext>();

/** The context of the current run, `undefined` outside of `withRun` (metrics and caching are no-ops there) */
export const getRunContext = (): RunContext | undefined => storage.getStore();

// Used outside of any run (e.g. unit tests calling fetchWithHostLimit or checkUrlsOnPageWithPlaywright directly):
// a single lazily created context with defaults, so there is still one host limiter, SSRF setting and browser.
let defaultContext: RunContext | undefined;
const getContext = (): RunContext => getRunContext() ?? (defaultContext ??= createRunContext());

/** The per-host limiter of the current run (or the default context outside of any run) */
export const getHostLimiter = (): HostLimiter => getContext().hostLimiter;

/** Only for tests: replace (or reset to a fresh default) the host limiter of the current run or default context */
export const setHostLimiter = (limiter: HostLimiter | undefined) => {
  getContext().hostLimiter = limiter ?? new HostLimiter(DEFAULT_HOST_CONCURRENCY);
};

/** Allow requests to private and local addresses, see `RunConfig.allowPrivateHosts` */
export const isPrivateHostsAllowed = (): boolean => getContext().allowPrivateHosts;

/** Slot holding the shared browser of the current run (or the default context), see `src/browser.ts` */
export const getBrowserSlot = (): BrowserSlot => getContext().browser;

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
 * run, requests use a dedicated per-host limiter (`config.hostConcurrency`, default 8) and SSRF guard setting
 * (`config.allowPrivateHosts`, default false). At the end (also on errors), the run metrics are logged and the
 * shared browser (if one was launched) is closed.
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
      console.log(formatRunMetrics(context.metrics, performance.now() - startTime));
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
  // Every `fetch()` call: each redirect hop, 429 retry and HEAD-to-GET fallback counts
  httpRequests: "HTTP requests (incl. redirects, retries and HEAD-to-GET fallbacks)",
  playwrightNavigations: "Playwright navigations",
  // Requests and navigations retried after a 502, 503 or 504 (included in the counts above)
  serverErrorRetries: "Retries after a server error (502, 503, 504)",
  // A hash missing in the shared DOM of its page is re-checked with a dedicated navigation (included above)
  playwrightHashFallbacks: "Playwright hash fallbacks",
  // A hash missing on the page opened with it is waited for again after the full load (late-rendered anchors)
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

const formatMs = (ms: number) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;

export const formatRunMetrics = (metrics: RunMetrics, totalMs?: number): string => {
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

type RunCachedOptions = {
  /** Should a rejection be cached too? By default, rejections are evicted so the next call retries. */
  cacheError?: (error: unknown) => boolean;
  onHit?: () => void;
  onMiss?: () => void;
};

/**
 * Memoizes `fn` by `key` for the current run. Concurrent callers share the same promise.
 * Outside of a run, `fn` is called every time.
 */
export const runCached = <T>(
  key: string,
  fn: () => Promise<T>,
  options: RunCachedOptions = {},
): Promise<T> => {
  const context = getRunContext();
  if (!context) {
    return fn();
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the cache holds promises of any type, keys are namespaced by the callers so a key always has the same type
  const cached = context.cache.get(key) as Promise<T> | undefined;
  if (cached) {
    options.onHit?.();
    return cached;
  }
  options.onMiss?.();
  const promise = fn();
  context.cache.set(key, promise);
  promise.catch((error) => {
    if (!options.cacheError?.(error) && context.cache.get(key) === promise) {
      context.cache.delete(key);
    }
  });
  return promise;
};
