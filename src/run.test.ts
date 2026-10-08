import { afterEach, describe, expect, it, vi } from "vitest";
import { getRunContext, incrementMetric, runCached, timePhase, withRun } from "./run";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("run context", () => {
  it("nested runs join the outer run", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await withRun({}, async () => {
      const outer = getRunContext();
      await withRun({}, async () => {
        expect(getRunContext()).toBe(outer);
      });
    });
    expect(getRunContext()).toBeUndefined();
  });

  it("logs metrics and phase timings at the end of the run, also after an error", async () => {
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const run = async (fail: boolean) => {
      await withRun({}, async () => {
        incrementMetric("playwrightNavigations");
        await timePhase("Slow phase", () => vi.advanceTimersByTimeAsync(1500));
        if (fail) {
          throw new Error("failed");
        }
      });
    };

    await run(false);
    await expect(run(true)).rejects.toThrow("failed");
    vi.useRealTimers();

    const output = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
    expect(output.match(/Run metrics:/g)).toHaveLength(2);
    expect(output).toContain("Playwright navigations: 1");
    // 1.5s are shown in seconds
    expect(output).toContain("Slow phase: 1.5s");
  });

  it("caching is a no-op outside of a run", async () => {
    const fn = vi.fn(async () => 1);
    await runCached("key", fn);
    await runCached("key", fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
