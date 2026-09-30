import PromisePool, { PromisePoolError, ProcessHandler } from "@supercharge/promise-pool";
import * as cliProgress from "cli-progress";
import { HostLimiter } from "./limiter";

export const log = (message: any, verbose = false) => {
  if (verbose) {
    console.log(message);
  }
};

/**
 * The progress bar redraws the terminal line, which only makes sense in an interactive terminal.
 * In CI (or when output is piped) it just spams the log, so it's disabled there.
 */
export const isProgressBarEnabled = () => Boolean(process.stderr.isTTY) && !process.env.CI;

/**
 * Creates a new progress bar (one per `parallelProcess` call, so nested pools don't restart a shared bar).
 * Returns `undefined` when the progress bar is disabled.
 */
export const createProgressBar = (): cliProgress.SingleBar | undefined => {
  if (!isProgressBarEnabled()) {
    return undefined;
  }
  return new cliProgress.SingleBar({ stopOnComplete: true });
};

/**
 * Human-readable description of an item that failed processing (used in error logs).
 */
export const describeItem = (item: unknown): string => {
  if (typeof item === "string") {
    return item;
  }
  if (item && typeof item === "object") {
    if ("href" in item && typeof item.href === "string") {
      return "page" in item && typeof item.page === "string"
        ? `${item.href} (on ${item.page})`
        : item.href;
    }
    try {
      // JSON.stringify returns undefined when toJSON() returns undefined
      return JSON.stringify(item) ?? String(item);
    } catch {
      return String(item);
    }
  }
  return String(item);
};

export const formatPoolErrors = <T>(errors: PromisePoolError<T>[]) =>
  errors.map((error) => `  - ${describeItem(error.item)}: ${error.message}`).join("\n");

type ParallelProcessArgs<T, R> = {
  items: T[];
  processFn: ProcessHandler<T, R>;
  concurrencyLimit?: number;
  /**
   * Per-task timeout in milliseconds (default `TASK_TIMEOUT`). Pass `null` to disable it, e.g. when tasks
   * wait in a queue (per-host limits) and every request inside already has its own timeout.
   */
  taskTimeout?: number | null;
};

export const parallelProcess = async <T, R>({
  items,
  processFn,
  concurrencyLimit = CONCURRENCY_LIMIT,
  taskTimeout = TASK_TIMEOUT,
}: ParallelProcessArgs<T, R>) => {
  const startTime = Date.now();
  const progressBar = createProgressBar();
  progressBar?.start(items.length, 0);
  try {
    const pool = PromisePool.withConcurrency(concurrencyLimit);
    const { results, errors } = await (taskTimeout === null ? pool : pool.withTaskTimeout(taskTimeout))
      .for(items)
      .onTaskFinished(() => {
        progressBar?.increment();
      })
      .process(processFn);

    if (errors.length > 0) {
      console.error(`Errors processing items: ${errors.length}\n${formatPoolErrors(errors)}`);
    }
    return { results, errors };
  } finally {
    progressBar?.stop();
    console.log(`Time taken: ${Date.now() - startTime}ms`);
  }
};

/**
 * Parses the `LINK_CHECK_SAMPLE_RATE` environment variable (float between 0 and 1, default 1).
 * @throws {Error} if the value is not a number between 0 and 1
 */
export const getSampleRate = (value = process.env.LINK_CHECK_SAMPLE_RATE): number => {
  if (value === undefined || value.trim() === "") {
    return 1;
  }
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new Error(`Invalid LINK_CHECK_SAMPLE_RATE "${value}", expected a number between 0 and 1.`);
  }
  return rate;
};

type SampleArgs<T> = {
  items: T[];
  /** Stable key used to sort the items, so the sample is deterministic */
  key: (item: T) => string;
  /** Defaults to `LINK_CHECK_SAMPLE_RATE` */
  rate?: number;
  label?: string;
};

/**
 * Deterministically picks a sample of `items`: sorts them by `key` and takes evenly spaced items.
 * Always returns at least one item (unless `items` is empty). Rate 1 returns all items unchanged.
 */
export const sampleItems = <T>({ items, key, rate = getSampleRate(), label = "pages" }: SampleArgs<T>): T[] => {
  if (rate >= 1 || items.length === 0) {
    return items;
  }
  const sorted = [...items].sort((a, b) => {
    const [keyA, keyB] = [key(a), key(b)];
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });
  const count = Math.max(1, Math.ceil(sorted.length * rate));
  const sample: T[] = [];
  for (let i = 0; i < count; i++) {
    sample.push(sorted[Math.floor((i * sorted.length) / count)]);
  }
  console.log(`Sampling ${sample.length} of ${items.length} ${label} (LINK_CHECK_SAMPLE_RATE=${rate}).`);
  return sample;
};

export const CONCURRENCY_LIMIT = 100;
export const PLAYWRIGHT_CONCURRENCY_LIMIT = 5;
export const DEFAULT_HOST_CONCURRENCY_LIMIT = 8;

/**
 * Parses the `LINK_CHECK_HOST_CONCURRENCY` environment variable (positive integer, default 8):
 * the maximum number of concurrent `fetch` requests to a single host.
 * @throws {Error} if the value is not a positive integer
 */
export const getHostConcurrencyLimit = (value = process.env.LINK_CHECK_HOST_CONCURRENCY): number => {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_HOST_CONCURRENCY_LIMIT;
  }
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Invalid LINK_CHECK_HOST_CONCURRENCY "${value}", expected a positive integer.`);
  }
  return limit;
};

let sharedHostLimiter: HostLimiter | undefined;
/** Per-host limiter shared by all `fetch` requests of the process (created lazily, so the env variable can be set first) */
export const getHostLimiter = (): HostLimiter => {
  sharedHostLimiter ??= new HostLimiter(getHostConcurrencyLimit());
  return sharedHostLimiter;
};
/** Only for tests: replace (or reset with `undefined`) the shared per-host limiter */
export const setHostLimiter = (limiter: HostLimiter | undefined) => {
  sharedHostLimiter = limiter;
};
// GitHub web rate limit makes you wait 60 seconds after 500 requests
export const TASK_TIMEOUT = 80000;
// Timeout of a single fetch request
export const FETCH_TIMEOUT = 20000;

export const OKAY_STATUS_CODES = [200, 301, 302, 303, 307, 308];
// Some websites have ReCaptcha or other anti-scraping measures that prevent us from checking their links, let's ignore/collect them separately
export const FORBIDDEN_STATUS_CODES = [403, 401];

// Spoofed user agents to bypass some websites restrictions

const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:110.0) Gecko/20100101 Firefox/110.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/109.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Android 14; Mobile; rv:110.0) Gecko/110.0 Firefox/110.0",
  "Mozilla/5.0 (Linux; Android 13; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/537.36",
  "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
];

export const getRandomUserAgent = () => userAgents[Math.floor(Math.random() * userAgents.length)];
