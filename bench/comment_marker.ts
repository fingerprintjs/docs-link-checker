/**
 * Hidden marker at the top of the benchmark's markdown report, so CI can find and update its own sticky PR comment
 * instead of posting a new one on every push (see `.github/workflows/benchmark.yaml`).
 */
export const COMMENT_MARKER = "<!-- docs-link-checker-benchmark -->";
