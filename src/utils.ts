import * as cliProgress from "cli-progress";
import pLimit from "p-limit";
import type { ConcurrentError } from "./limiter";
import { getErrorMessage } from "./utils/errors";

/**
 * The progress bar redraws the terminal line, which only makes sense in an interactive terminal.
 * In CI (or when output is piped) it just spams the log, so it's disabled there.
 */
const isProgressBarEnabled = (): boolean => process.stderr.isTTY && !process.env.CI;

/**
 * Creates a new progress bar (one per `parallelProcess` call, so nested pools don't restart a shared bar).
 * Returns `undefined` when the progress bar is disabled.
 */
const createProgressBar = (): cliProgress.SingleBar | undefined => {
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
      const json = JSON.stringify(item);
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- the types say `string`, but JSON.stringify returns undefined when toJSON() returns undefined
      return json ?? Object.prototype.toString.call(item);
    } catch {
      return Object.prototype.toString.call(item);
    }
  }
  return String(item);
};

export const formatConcurrentErrors = <T>(errors: ConcurrentError<T>[]) =>
  errors
    .map((error) => `  - ${describeItem(error.item)}: ${getErrorMessage(error.error)}`)
    .join("\n");

type ParallelProcessArgs<T, R> = {
  items: T[];
  processFn: (item: T) => Promise<R>;
  concurrencyLimit?: number;
};

/**
 * Runs `processFn` over `items` with at most `concurrencyLimit` concurrent calls, a progress bar (interactive
 * terminals only) and error logging. A throwing `processFn` does not stop the other items.
 * @returns successful results and errors, both in item order
 */
export const parallelProcess = async <T, R>({
  items,
  processFn,
  concurrencyLimit = CONCURRENCY_LIMIT,
}: ParallelProcessArgs<T, R>) => {
  const startTime = Date.now();
  const progressBar = createProgressBar();
  progressBar?.start(items.length, 0);
  try {
    const limit = pLimit(concurrencyLimit);
    const tasks = items.map((item) => ({
      item,
      done: limit(async () => {
        try {
          return await processFn(item);
        } finally {
          progressBar?.increment();
        }
      }),
    }));
    await Promise.allSettled(tasks.map((task) => task.done));
    const results: R[] = [];
    const errors: ConcurrentError<T>[] = [];
    for (const { item, done } of tasks) {
      try {
        results.push(await done);
      } catch (error) {
        errors.push({ item, error });
      }
    }

    if (errors.length > 0) {
      console.error(`Errors processing items: ${errors.length}\n${formatConcurrentErrors(errors)}`);
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
    throw new Error(
      `Invalid LINK_CHECK_SAMPLE_RATE "${value}", expected a number between 0 and 1.`,
    );
  }
  return rate;
};

type SampleArgs<T> = {
  items: T[];
  /** Stable key used to sort the items, so the sample is deterministic */
  key: (item: T) => string;
  /** Defaults to `LINK_CHECK_SAMPLE_RATE` (also when `undefined` is passed explicitly) */
  rate?: number;
  label?: string;
};

/**
 * Deterministically picks a sample of `items`: sorts them by `key` and takes evenly spaced items.
 * Always returns at least one item (unless `items` is empty). Rate 1 returns all items unchanged.
 */
export const sampleItems = <T>({
  items,
  key,
  rate = getSampleRate(),
  label = "pages",
}: SampleArgs<T>): T[] => {
  if (rate >= 1 || items.length === 0) {
    return items;
  }
  const sorted = items.toSorted((a, b) => compareStrings(key(a), key(b)));
  const count = Math.max(1, Math.ceil(sorted.length * rate));
  const sample: T[] = [];
  for (let i = 0; i < count; i++) {
    // count <= sorted.length, so the index is always in range
    const item = sorted[Math.floor((i * sorted.length) / count)];
    if (item !== undefined) {
      sample.push(item);
    }
  }
  console.log(`Sampling ${sample.length} of ${items.length} ${label} (sample rate ${rate}).`);
  return sample;
};

export const CONCURRENCY_LIMIT = 100;

/** Code unit order (like the default `sort()`), not locale-dependent */
export const compareStrings = (a: string, b: string): number => Number(a > b) - Number(a < b);
