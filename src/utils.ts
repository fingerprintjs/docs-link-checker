import { Clock, Console, Effect, Either, Ref } from "effect";
import { getErrorMessage } from "./utils/errors";

// Long runs print progress, also in CI where an interactive progress bar would spam the log
const PROGRESS_LOG_INTERVAL = 30000;

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

/** An item whose processing failed, with its error */
export type ConcurrentError<T, E> = { item: T; error: E };

const formatConcurrentErrors = <T, E>(errors: ConcurrentError<T, E>[]) =>
  errors
    .map((error) => `  - ${describeItem(error.item)}: ${getErrorMessage(error.error)}`)
    .join("\n");

type ProcessInParallelArgs<T, A, E, R> = {
  items: T[];
  processFn: (item: T) => Effect.Effect<A, E, R>;
  concurrencyLimit?: number;
};

/**
 * Runs `processFn` over `items` with at most `concurrencyLimit` concurrent fibers, progress logs and error
 * logging. A failing `processFn` does not stop the other items. Interrupting it interrupts the running items.
 * @returns successful results and errors, both in item order
 */
export const processInParallel = <T, A, E, R>({
  items,
  processFn,
  concurrencyLimit = CONCURRENCY_LIMIT,
}: ProcessInParallelArgs<T, A, E, R>) =>
  Effect.gen(function* () {
    const startTime = yield* Clock.currentTimeMillis;
    const done = yield* Ref.make(0);
    // Stopped with the scope, also when the items are interrupted
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.zipRight(
          Effect.sleep(PROGRESS_LOG_INTERVAL),
          Effect.flatMap(Ref.get(done), (count) =>
            Console.log(`Progress: ${count}/${items.length}`),
          ),
        ),
      ),
    );
    const settled = yield* Effect.forEach(
      items,
      (item) =>
        processFn(item).pipe(
          Effect.either,
          Effect.ensuring(Ref.update(done, (count) => count + 1)),
        ),
      { concurrency: concurrencyLimit },
    ).pipe(
      Effect.ensuring(
        Effect.flatMap(Clock.currentTimeMillis, (end) =>
          Console.log(`Time taken: ${end - startTime}ms`),
        ),
      ),
    );

    const results: A[] = [];
    const errors: ConcurrentError<T, E>[] = [];
    for (const [i, item] of items.entries()) {
      const outcome = settled[i];
      if (outcome === undefined) {
        continue;
      }
      if (Either.isRight(outcome)) {
        results.push(outcome.right);
      } else {
        errors.push({ item, error: outcome.left });
      }
    }
    if (errors.length > 0) {
      yield* Console.error(
        `Errors processing items: ${errors.length}\n${formatConcurrentErrors(errors)}`,
      );
    }
    return { results, errors };
  }).pipe(Effect.scoped);

type ParallelProcessArgs<T, R> = {
  items: T[];
  processFn: (item: T) => Promise<R>;
  concurrencyLimit?: number;
};

// TODO(effect): remove once callers use `processInParallel`
/** Promise version of `processInParallel`, a rejecting `processFn` is an error of its item */
export const parallelProcess = <T, R>({
  items,
  processFn,
  concurrencyLimit,
}: ParallelProcessArgs<T, R>) =>
  Effect.runPromise(
    processInParallel({
      items,
      concurrencyLimit,
      processFn: (item) =>
        Effect.tryPromise({ try: () => processFn(item), catch: (error) => error }),
    }),
  );

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
