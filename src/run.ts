import { beginBrowserRun, endBrowserRun } from "./browser";
import { createRunContext, formatRunMetrics, getRunContext, runInContext } from "./run_context";
import { getHostLimiter } from "./utils";

/**
 * Runs `fn` as a link-check run: in-memory caches (GitHub API responses...) and metrics live for the duration of the run.
 * At the end (also on errors), the run metrics are logged and the shared browser is closed, unless another
 * concurrent run still uses it (reference-counted).
 * Nested calls (e.g. `checkLinks` inside `checkWebsite`) join the outer run.
 */
export const withRun = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (getRunContext()) {
    return fn();
  }
  // Fail fast on invalid configuration (e.g. LINK_CHECK_HOST_CONCURRENCY), before any work. Otherwise the error would
  // be thrown inside individual checks and reported as broken links or page extraction errors.
  getHostLimiter();
  const context = createRunContext();
  return runInContext(context, async () => {
    const startTime = performance.now();
    beginBrowserRun();
    try {
      return await fn();
    } finally {
      await endBrowserRun();
      console.log(formatRunMetrics(context.metrics, performance.now() - startTime));
    }
  });
};
