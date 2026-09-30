import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
}));

vi.mock("playwright", () => {
  const launch = async () => {
    state.launches++;
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
        disconnectedHandlers.forEach((handler) => handler());
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
            return {
              goto: async (url: string) => {
                state.visited.push(url);
                await new Promise((resolve) => setTimeout(resolve, state.gotoDelayMs));
                return { status: () => 200, statusText: () => "", text: async () => "", ok: () => true };
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

import { closeBrowser, getBrowser, withPage } from "./browser";
import { checkLinks, checkLinkWithPlaywright } from "./link";
import { PLAYWRIGHT_CONCURRENCY_LIMIT } from "./utils";
import { withRun } from "./run";

const link = (href: string) => ({ href, page: "https://example.com/source", text: "link" });

beforeEach(async () => {
  await closeBrowser();
  Object.assign(state, {
    launches: 0,
    closes: 0,
    openPages: 0,
    maxOpenPages: 0,
    visited: [],
    crashNextContext: false,
    gotoDelayMs: 10,
    routes: 0,
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await closeBrowser();
  vi.restoreAllMocks();
});

describe("shared browser", () => {
  it("launches one browser for many Playwright checks and closes it at the end of checkLinks", async () => {
    // 403 from fetch -> every link is re-checked with Playwright
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 403 })));
    const links = Array.from({ length: 20 }, (_, i) => link(`https://blocked-${i}.example.com/page`));

    const { results, errors } = await checkLinks({ links });

    expect(errors).toHaveLength(0);
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
      withRun(async () => {
        await checkLinkWithPlaywright("https://example.com/a");
        throw new Error("run failed");
      })
    ).rejects.toThrow("run failed");

    expect(state.launches).toBe(1);
    expect(state.closes).toBe(1);
    await closeBrowser(); // safe to call again
    expect(state.closes).toBe(1);
  });

  it("does not launch a browser when nothing needs Playwright", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    await checkLinks({ links: [link("https://example.com/ok")] });
    expect(state.launches).toBe(0);
  });

  it("shares a single launch between concurrent callers and limits open pages", async () => {
    state.gotoDelayMs = 20;
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => checkLinkWithPlaywright(`https://example.com/${i}`))
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
      })
    ).rejects.toThrow("boom");
    expect(state.launches).toBe(1);
    // The context is closed even when the check throws
    expect(state.openPages).toBe(0);
  });
});
