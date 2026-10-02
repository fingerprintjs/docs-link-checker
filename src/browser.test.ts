import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Offline tests for the shared browser (`browser.ts`) with a fake Playwright.
 */

const state = vi.hoisted(() => ({
  launches: 0,
  closes: 0,
  openPages: 0,
  maxOpenPages: 0,
  visited: [] as string[],
  // Make the next `newContext` call fail as if the browser crashed
  crashNextContext: false,
  gotoDelayMs: 10,
  routes: 0,
  // Make the next navigation fail: "crash" closes the browser, "error" is a navigation error (e.g. DNS)
  nextGotoFailure: null as "crash" | "error" | null,
  failLaunch: false,
}));

vi.mock("playwright", () => {
  const launch = async () => {
    state.launches++;
    if (state.failLaunch) {
      throw new Error("browserType.launch: Executable doesn't exist");
    }
    let connected = true;
    const disconnectedHandlers: Array<() => void> = [];
    const browser = {
      isConnected: () => connected,
      on: (event: string, handler: () => void) => {
        if (event === "disconnected") disconnectedHandlers.push(handler);
      },
      close: async () => {
        state.closes++;
        connected = false;
        for (const handler of disconnectedHandlers) handler();
      },
      newContext: async () => {
        if (state.crashNextContext) {
          state.crashNextContext = false;
          connected = false;
          throw new Error("Target page, context or browser has been closed");
        }
        return {
          route: async () => {
            state.routes++;
          },
          close: async () => {
            state.openPages--;
          },
          newPage: async () => {
            state.openPages++;
            state.maxOpenPages = Math.max(state.maxOpenPages, state.openPages);
            let closed = false;
            return {
              isClosed: () => closed,
              setDefaultTimeout: () => {},
              setDefaultNavigationTimeout: () => {},
              goto: async (url: string) => {
                const failure = state.nextGotoFailure;
                state.nextGotoFailure = null;
                if (failure === "crash") {
                  connected = false;
                  closed = true;
                  throw new Error("page.goto: Target crashed");
                }
                if (failure === "error") {
                  throw new Error("page.goto: net::ERR_NAME_NOT_RESOLVED");
                }
                state.visited.push(url);
                await new Promise((resolve) => setTimeout(resolve, state.gotoDelayMs));
                return {
                  status: () => 200,
                  statusText: () => "",
                  text: async () => "",
                  ok: () => true,
                };
              },
              locator: () => ({ first: () => ({ waitFor: async () => {} }) }),
            };
          },
        };
      },
    };
    return browser;
  };
  return { chromium: { launch: vi.fn(launch) } };
});

import { getBrowser, PLAYWRIGHT_CONCURRENCY_LIMIT, withPage } from "./browser";
import { checkLinks } from "./link";
import { checkLinkWithPlaywright } from "./playwright_check";
import { closeRunBrowser, withRun } from "./run";

const link = (href: string) => ({ href, page: "https://example.com/source", text: "link" });

beforeEach(async () => {
  await closeRunBrowser();
  Object.assign(state, {
    launches: 0,
    closes: 0,
    openPages: 0,
    maxOpenPages: 0,
    visited: [],
    crashNextContext: false,
    gotoDelayMs: 10,
    routes: 0,
    nextGotoFailure: null,
    failLaunch: false,
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await closeRunBrowser();
  vi.restoreAllMocks();
});

describe("shared browser", () => {
  it("launches one browser for many Playwright checks and closes it at the end of checkLinks", async () => {
    // 403 from fetch -> every link is re-checked with Playwright
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 403 })),
    );
    const links = Array.from({ length: 20 }, (_, i) =>
      link(`https://blocked-${i}.example.com/page`),
    );

    const results = await checkLinks({ links });

    expect(results).toHaveLength(20);
    expect(state.visited).toHaveLength(20);
    expect(state.launches).toBe(1);
    expect(state.closes).toBe(1);
    // One context (with resource blocking) per check, bounded concurrency
    expect(state.routes).toBe(20);
    expect(state.maxOpenPages).toBeLessThanOrEqual(PLAYWRIGHT_CONCURRENCY_LIMIT);
    expect(state.openPages).toBe(0);
  });

  it("closes the browser even when the run fails", async () => {
    await expect(
      withRun({}, async () => {
        await checkLinkWithPlaywright("https://example.com/a");
        throw new Error("run failed");
      }),
    ).rejects.toThrow("run failed");

    expect(state.launches).toBe(1);
    expect(state.closes).toBe(1);
    await closeRunBrowser(); // safe to call again
    expect(state.closes).toBe(1);
  });

  it("does not launch a browser when nothing needs Playwright", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    await checkLinks({ links: [link("https://example.com/ok")] });
    expect(state.launches).toBe(0);
  });

  it("shares a single launch between concurrent callers and limits open pages", async () => {
    state.gotoDelayMs = 20;
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => checkLinkWithPlaywright(`https://example.com/${i}`)),
    );

    expect(results.every((result) => result.ok)).toBe(true);
    expect(state.launches).toBe(1);
    expect(state.maxOpenPages).toBe(PLAYWRIGHT_CONCURRENCY_LIMIT);
  });

  it("relaunches a crashed browser once and retries the check", async () => {
    await getBrowser();
    state.crashNextContext = true;

    const result = await checkLinkWithPlaywright("https://example.com/after-crash");

    expect(result).toEqual({ ok: true, status: 200 });
    expect(state.launches).toBe(2);
    expect(state.visited).toEqual(["https://example.com/after-crash"]);
  });

  it("does not retry errors that are not crashes", async () => {
    await expect(
      withPage(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(state.launches).toBe(1);
    // The context is closed even when the check throws
    expect(state.openPages).toBe(0);
  });

  it("relaunches the browser when it crashes during navigation and retries the check", async () => {
    await getBrowser();
    state.nextGotoFailure = "crash";

    const result = await checkLinkWithPlaywright("https://example.com/crash");

    expect(result).toEqual({ ok: true, status: 200 });
    expect(state.launches).toBe(2);
  });

  it("reports navigation errors as broken links (no relaunch)", async () => {
    state.nextGotoFailure = "error";

    const result = await checkLinkWithPlaywright("https://does-not-exist.example.com");

    expect(result).toMatchObject({ ok: false, error: "broken link" });
    expect(!result.ok && result.errorDetail).toContain("ERR_NAME_NOT_RESOLVED");
    expect(state.launches).toBe(1);
  });

  it("reports browser launch failures as unexpected errors (not broken links)", async () => {
    state.failLaunch = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 403 })),
    );

    const results = await checkLinks({
      links: [link("https://blocked.example.com/a"), link("https://blocked.example.com/a#x")],
    });

    // One "unexpected error" result per link, like any other failure
    expect(results.map((result) => result.href)).toEqual([
      "https://blocked.example.com/a",
      "https://blocked.example.com/a#x",
    ]);
    expect(
      results.every((result) => !result.result.ok && result.result.error === "unexpected error"),
    ).toBe(true);
    expect(
      results.every(
        (result) =>
          !result.result.ok && result.result.errorDetail?.includes("Executable doesn't exist"),
      ),
    ).toBe(true);
  });
});

describe("browser belongs to the run", () => {
  it("closes the browser at the end of its own run, independently of other concurrent runs", async () => {
    state.gotoDelayMs = 50;
    const first = withRun({}, () => checkLinkWithPlaywright("https://example.com/first"));
    const second = withRun({}, () => checkLinkWithPlaywright("https://example.com/second"));

    expect(await first).toEqual({ ok: true, status: 200 });
    expect(state.closes).toBe(1);
    // The second run still has its own (separate) browser open
    expect(state.launches).toBe(2);

    expect(await second).toEqual({ ok: true, status: 200 });
    expect(state.closes).toBe(2);
  });

  it("closes the run's browser even when the run fails, standalone checks are unaffected", async () => {
    await expect(
      withRun({}, async () => {
        await checkLinkWithPlaywright("https://example.com/a");
        throw new Error("run failed");
      }),
    ).rejects.toThrow("run failed");
    expect(state.launches).toBe(1);
    expect(state.closes).toBe(1);

    // A standalone check (outside of any run) uses its own (default context) browser
    const result = await checkLinkWithPlaywright("https://example.com/standalone");
    expect(result).toEqual({ ok: true, status: 200 });
    expect(state.launches).toBe(2);
    expect(state.closes).toBe(1);

    await closeRunBrowser();
    expect(state.closes).toBe(2);
  });
});
