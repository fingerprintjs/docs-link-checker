import { afterEach, describe, expect, it, vi } from "vitest";
import { getRunContext, incrementMetric, runCached, timePhase, withRun } from "./run";
import { createTerminal } from "./terminal";

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

  it("shows metrics and phase timings at the end of the run with --verbose, also after an error", async () => {
    vi.useFakeTimers();
    let output = "";
    const terminal = createTerminal({
      write: (text) => {
        output += text;
      },
      stream: process.stdout,
      tty: false,
      verbose: true,
    });
    const run = async (fail: boolean) => {
      await withRun({ terminal }, async () => {
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

    expect(output.match(/Run metrics:/g)).toHaveLength(2);
    expect(output).toContain("Playwright navigations: 1");
    // 1.5s are shown in seconds
    expect(output).toContain("Slow phase: 1.5s");
  });

  it("shows nothing without --verbose", async () => {
    let output = "";
    const terminal = createTerminal({
      write: (text) => {
        output += text;
      },
      stream: process.stdout,
      tty: false,
    });
    await withRun({ terminal }, async () => incrementMetric("playwrightNavigations"));
    expect(output).toBe("");
  });

  it("caching is a no-op outside of a run", async () => {
    const fn = vi.fn(async () => 1);
    await runCached("key", fn);
    await runCached("key", fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
