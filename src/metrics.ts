/**
 * Per-run counters and phase timings, logged as a summary when the run ends (also on failure and interrupt).
 * Own service instead of `effect/Metric`: that one lives in a process-global registry, so it has no per-run
 * totals (bench rounds, many runs per test process) and cannot print this exact text.
 */
import { Clock, Context, Effect, Layer, Ref } from "effect";

/** Metric names and their labels in the summary log */
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

export type MetricsSnapshot = {
  readonly counters: Readonly<Record<string, number>>;
  readonly phases: ReadonlyArray<{ readonly name: string; readonly ms: number }>;
  /** Since the layer was built */
  readonly totalMs: number;
};

const formatMs = (ms: number) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;

export const formatRunMetrics = (snapshot: MetricsSnapshot): string => {
  const lines = ["Run metrics:"];
  for (const [name, label] of Object.entries(METRICS)) {
    const value = snapshot.counters[name];
    if (value !== undefined) {
      lines.push(`  ${label}: ${value}`);
    }
  }
  if (snapshot.phases.length > 0) {
    lines.push("  Phases:");
    for (const phase of snapshot.phases) {
      lines.push(`    ${phase.name}: ${formatMs(phase.ms)}`);
    }
  }
  lines.push(`  Total: ${formatMs(snapshot.totalMs)}`);
  return lines.join("\n");
};

export class Metrics extends Context.Tag("Metrics")<
  Metrics,
  {
    readonly increment: (name: MetricName, by?: number) => Effect.Effect<void>;
    /** Records the duration also when `effect` fails or is interrupted */
    readonly timePhase: <A, E, R>(
      name: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly snapshot: Effect.Effect<MetricsSnapshot>;
  }
>() {
  /** Closing the scope logs the summary, so build it first to log last (after e.g. the browser closed) */
  static readonly layer: Layer.Layer<Metrics> = Layer.scoped(
    Metrics,
    Effect.gen(function* () {
      const startMs = yield* Clock.currentTimeMillis;
      const counters = yield* Ref.make<Readonly<Record<string, number>>>({});
      const phases = yield* Ref.make<MetricsSnapshot["phases"]>([]);

      const snapshot = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        return {
          counters: yield* Ref.get(counters),
          phases: yield* Ref.get(phases),
          totalMs: now - startMs,
        };
      });

      yield* Effect.addFinalizer(() =>
        snapshot.pipe(Effect.flatMap((value) => Effect.logInfo(formatRunMetrics(value)))),
      );

      return {
        increment: (name, by = 1) =>
          Ref.update(counters, (current) => ({ ...current, [name]: (current[name] ?? 0) + by })),
        timePhase: (name, effect) =>
          Effect.gen(function* () {
            const start = yield* Clock.currentTimeMillis;
            return yield* effect.pipe(
              Effect.ensuring(
                Effect.gen(function* () {
                  const end = yield* Clock.currentTimeMillis;
                  yield* Ref.update(phases, (current) => [...current, { name, ms: end - start }]);
                }),
              ),
            );
          }),
        snapshot,
      };
    }),
  );
}
