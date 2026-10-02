import { AsyncLocalStorage } from "node:async_hooks";

/**
 * State of a single link-check run (`checkWebsite`, `checkReadmesInGithubOrg` or a standalone `checkLinks`):
 * in-memory caches and metrics. Code running outside a run simply does not cache or count anything.
 */
export type RunContext = {
  cache: Map<string, Promise<unknown>>;
  metrics: RunMetrics;
};

export type RunMetrics = {
  counters: Record<string, number>;
  phases: Array<{ name: string; ms: number }>;
};

const storage = new AsyncLocalStorage<RunContext>();

export const createRunContext = (): RunContext => ({
  cache: new Map(),
  metrics: { counters: {}, phases: [] },
});

export const getRunContext = (): RunContext | undefined => storage.getStore();

export const runInContext = <T>(context: RunContext, fn: () => Promise<T>): Promise<T> =>
  storage.run(context, fn);

/** Metric names used in the summary log */
export const METRICS = {
  totalLinks: "Total links",
  uniqueUrls: "Unique URLs",
  uniquePages: "Unique pages (URLs without hash)",
  // Distinct page fetches of link checks (per URL without hash and method), whatever the number of links to the page
  uniquePagesFetched: "Unique pages fetched",
  // Every `fetch()` call: each redirect hop, 429 retry and HEAD-to-GET fallback counts
  httpRequests: "HTTP requests (incl. redirects, retries and HEAD-to-GET fallbacks)",
  playwrightNavigations: "Playwright navigations",
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

export const setMetric = (name: MetricName, value: number) => {
  const metrics = getRunContext()?.metrics;
  if (metrics) {
    metrics.counters[name] = value;
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
