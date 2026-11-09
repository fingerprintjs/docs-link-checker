import pLimit from "p-limit";
import { getTerminal } from "../run";
import { formatDuration } from "../terminal";
import { getErrorMessage } from "./errors";
import type { ConcurrentError } from "./limiter";
import { compareStrings } from "./strings";

/**
 * Human-readable description of an item that failed processing:
 * - a link: `href` and the page it is on
 * - a README file: `sourcePath`
 * - a GitHub repository: `full_name` (`owner/repo`)
 */
const describeItem = (item: unknown): string => {
  if (typeof item !== "object" || !item) {
    return String(item);
  }
  if ("href" in item && typeof item.href === "string") {
    return "page" in item && typeof item.page === "string"
      ? `${item.href} (on ${item.page})`
      : item.href;
  }
  if ("sourcePath" in item && typeof item.sourcePath === "string") {
    return item.sourcePath;
  }
  if ("full_name" in item && typeof item.full_name === "string") {
    return item.full_name;
  }
  // Items of all callers are plain data
  return JSON.stringify(item);
};

const formatConcurrentErrors = <T>(errors: ConcurrentError<T>[]) =>
  errors
    .map((error) => `  - ${describeItem(error.item)}: ${getErrorMessage(error.error)}`)
    .join("\n");

type ParallelProcessArgs<T, R> = {
  items: T[];
  processFn: (item: T) => Promise<R>;
  concurrencyLimit?: number;
  /** Shows progress of the batch under this name, no progress without it */
  label?: string;
  /** Number of items that already failed (shown next to the progress) */
  failing?: () => number;
};

/**
 * Runs `processFn` over `items` with at most `concurrencyLimit` concurrent calls, progress and error
 * logging. A throwing `processFn` does not stop the other items.
 * @returns successful results and errors, both in item order
 */
export const parallelProcess = async <T, R>({
  items,
  processFn,
  concurrencyLimit = CONCURRENCY_LIMIT,
  label,
  failing,
}: ParallelProcessArgs<T, R>) => {
  const terminal = getTerminal();
  const startTime = performance.now();
  let done = 0;
  // Starts the step clock (quiet period, ETA) with the batch, not with the first finished item
  if (label) {
    terminal.progress(label, 0, items.length, failing?.());
  }
  try {
    const limit = pLimit(concurrencyLimit);
    const settled = await Promise.allSettled(
      items.map((item) =>
        limit(async () => {
          try {
            return await processFn(item);
          } finally {
            done++;
            if (label) {
              terminal.progress(label, done, items.length, failing?.());
            }
          }
        }),
      ),
    );
    const results: R[] = [];
    const errors: ConcurrentError<T>[] = [];
    for (const [i, item] of items.entries()) {
      const outcome = settled[i];
      if (outcome?.status === "fulfilled") {
        results.push(outcome.value);
      } else {
        errors.push({ item, error: outcome?.reason });
      }
    }

    if (errors.length > 0) {
      // Else the error is appended to the live progress line
      terminal.clear();
      console.error(`Errors processing items: ${errors.length}\n${formatConcurrentErrors(errors)}`);
    }
    return { results, errors };
  } finally {
    terminal.verbose(
      `${label ?? "Batch"}: ${items.length} items in ${formatDuration(performance.now() - startTime)}`,
    );
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
  getTerminal().line(
    getTerminal().paint(
      "dim",
      `Sampling ${sample.length} of ${items.length} ${label} (sample rate ${rate})`,
    ),
  );
  return sample;
};

export const CONCURRENCY_LIMIT = 100;
