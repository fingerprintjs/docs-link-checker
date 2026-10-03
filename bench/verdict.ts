/** Median of a non-empty array (average of the two middle values for an even length) */
export const median = (values: number[]): number => {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    // length >= 2 here, both indices are in range
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  }
  return sorted[mid] ?? 0;
};

export type Stat = { median: number; min: number; max: number };

/** Median, min and max of `values` (every array passed to a round aggregator is non-empty: at least one round ran) */
export const summarize = (values: number[]): Stat => ({
  median: median(values),
  min: Math.min(...values),
  max: Math.max(...values),
});

export type Verdict = "better" | "worse" | "same";

// A time regression/improvement must clear both a relative (noise) and an absolute (meaningfulness) bar
const TIME_RELATIVE_THRESHOLD = 0.15;
const TIME_ABSOLUTE_THRESHOLD_MS = 5000;

/**
 * Verdict for a timed phase or total: "worse" if `head` is both >15% and >5s slower than `base`, "better" if it's
 * the symmetric case, "same" otherwise. Both bars matter: a long phase can drift 15% from noise alone, a short one
 * can double and still not matter. Also used for the benchmark's overall verdict, on the total time (counters are
 * reported but, being noisier to attribute a cause to in isolation, don't change the headline verdict on their own).
 */
export const verdictForTime = (baseMedian: number, headMedian: number): Verdict => {
  const diff = headMedian - baseMedian;
  let relative = diff / baseMedian;
  if (baseMedian === 0) {
    relative = diff === 0 ? 0 : Infinity;
  }
  if (diff > TIME_ABSOLUTE_THRESHOLD_MS && relative > TIME_RELATIVE_THRESHOLD) {
    return "worse";
  }
  if (diff < -TIME_ABSOLUTE_THRESHOLD_MS && relative < -TIME_RELATIVE_THRESHOLD) {
    return "better";
  }
  return "same";
};
