/**
 * Shared helpers of the check pipelines: bounded concurrent processing with progress and error logs,
 * deterministic sampling.
 */
import { Cause, Clock, Effect, Exit, Ref, Schedule } from "effect";
import { getErrorMessage } from "./errors";

export const CONCURRENCY_LIMIT = 100;

// Long runs print progress, also in CI where an interactive progress bar would spam the log
const PROGRESS_LOG_INTERVAL = "30 seconds";

/** Code unit order (like the default `sort()`), not locale-dependent */
export const compareStrings = (a: string, b: string): number => Number(a > b) - Number(a < b);

/** An item whose processing failed, with the failure */
type ItemError<T> = { readonly item: T; readonly error: unknown };

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

/**
 * Runs `process` over `items` with at most `concurrency` running at once. A failing or dying item does not stop the
 * others (each runs under `Effect.exit`, the error is `Cause.squash` of its cause).
 * Logs progress every 30s, the failed items and the time taken (also when interrupted).
 * @returns successful results and errors, both in item order
 */
export const processAll = Effect.fn("utils.processAll")(function* <T, A, E, R>(args: {
  readonly items: ReadonlyArray<T>;
  readonly process: (item: T) => Effect.Effect<A, E, R>;
  readonly concurrency?: number;
}) {
  const { items, process, concurrency = CONCURRENCY_LIMIT } = args;
  const start = yield* Clock.currentTimeMillis;
  const done = yield* Ref.make(0);

  const runItem = (item: T) =>
    process(item).pipe(
      Effect.exit,
      Effect.tap(() => Ref.update(done, (count) => count + 1)),
    );
  const logProgress = Ref.get(done).pipe(
    Effect.flatMap((count) => Effect.logInfo(`Progress: ${count}/${items.length}`)),
    Effect.schedule(Schedule.spaced(PROGRESS_LOG_INTERVAL)),
    Effect.forkScoped,
  );
  const logTimeTaken = Effect.flatMap(Clock.currentTimeMillis, (end) =>
    Effect.logInfo(`Time taken: ${end - start}ms`),
  );

  const run = Effect.gen(function* () {
    const outcomes = yield* Effect.zipRight(
      logProgress,
      Effect.forEach(items, runItem, { concurrency }),
    ).pipe(Effect.scoped);

    const results: A[] = [];
    const errors: ItemError<T>[] = [];
    for (const [index, item] of items.entries()) {
      const outcome = outcomes[index];
      if (outcome && Exit.isFailure(outcome)) {
        errors.push({ item, error: Cause.squash(outcome.cause) });
      } else if (outcome) {
        results.push(outcome.value);
      }
    }

    if (errors.length > 0) {
      yield* Effect.logError(
        `Errors processing items: ${errors.length}\n${errors
          .map(({ item, error }) => `  - ${describeItem(item)}: ${getErrorMessage(error)}`)
          .join("\n")}`,
      );
    }
    return { results, errors };
  });

  return yield* run.pipe(Effect.ensuring(logTimeTaken));
});

/**
 * Deterministically picks a sample of `items`: sorts them by `key` and takes evenly spaced items.
 * Always returns at least one item (unless `items` is empty). Rate 1 returns all items unchanged.
 */
export const sampleItems = <T>({
  items,
  key,
  rate,
  label = "pages",
}: {
  readonly items: ReadonlyArray<T>;
  /** Stable key used to sort the items, so the sample is deterministic */
  readonly key: (item: T) => string;
  readonly rate: number;
  readonly label?: string;
}): Effect.Effect<T[]> =>
  Effect.gen(function* () {
    if (rate >= 1 || items.length === 0) {
      return [...items];
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
    yield* Effect.logInfo(
      `Sampling ${sample.length} of ${items.length} ${label} (sample rate ${rate}).`,
    );
    return sample;
  });
