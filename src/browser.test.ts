import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPlaywrightChromium, withPage } from "./browser";
import { checkLinks as checkLinksInRun } from "./link";
import { checkUrlsOnPageWithPlaywright } from "./playwright_check";
import { PLAYWRIGHT_CONCURRENCY_LIMIT, withRun } from "./run";

/**
 * Offline tests for the shared browser (`browser.ts`) with a fake Playwright.
 */

const state = {
  launches: 0,
  closes: 0,
  openPages: 0,
  maxOpenPages: 0,
  visited: [] as string[],
  // Make the next `newContext` call fail as if the browser crashed
  crashNextContext: false,
  gotoDelayMs: 10,
  // Navigation to a URL in here waits until the promise resolves
  gotoGates: {} as Record<string, Promise<void>>,
  // Route handler of the latest context, as registered by `withPage`
  routeHandler: null as null | ((route: unknown) => Promise<void>),
  // Make the next navigation fail: "crash" closes the browser, "error" is a navigation error (e.g. DNS)
  nextGotoFailure: null as "crash" | "error" | null,
  failLaunch: false as false | "missing" | "other",
  installs: 0,
  failInstall: false,
  // Status of every `fetch` of the run (403: links are re-checked with Playwright)
  fetchStatus: 200,
};

const fakeChromium = (() => {
  const launch = async () => {
    state.launches++;
    if (state.failLaunch === "missing") {
      throw new Error("browserType.launch: Executable doesn't exist");
    }
    if (state.failLaunch === "other") {
      throw new Error("browserType.launch: Failed to launch: Target closed");
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
          route: async (_pattern: string, handler: (route: unknown) => Promise<void>) => {
            state.routeHandler = handler;
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
                await state.gotoGates[url];
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
  return { launch };
})();

const installChromium = () => {
  state.installs++;
  if (state.failInstall) {
    throw new Error("playwright install failed");
  }
  state.failLaunch = false;
};

/** Runs `fn` as a run with a fake browser, the browser is closed at the end of the run */
const inRun = <T>(fn: () => Promise<T>) =>
  withRun(
    {
      deps: {
        fetch: async () => new Response(null, { status: state.fetchStatus }),
        chromium: fakeChromium as never,
        installChromium,
      },
    },
    fn,
  );

const checkLinks = (options: Parameters<typeof checkLinksInRun>[0]) =>
  inRun(() => checkLinksInRun(options));

const launchBrowser = () => withPage(async () => {}, { timeout: 1000 });

const checkLinkWithPlaywright = async (url: string) =>
  (await checkUrlsOnPageWithPlaywright([url])).get(url)!;

const link = (href: string) => ({ href, page: "https://example.com/source", text: "link" });

beforeEach(() => {
  Object.assign(state, {
    launches: 0,
    closes: 0,
    openPages: 0,
    maxOpenPages: 0,
    visited: [],
    crashNextContext: false,
    gotoDelayMs: 10,
    gotoGates: {},
    routeHandler: null,
    nextGotoFailure: null,
    failLaunch: false,
    installs: 0,
    failInstall: false,
    fetchStatus: 200,
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shared browser", () => {
  it("launches one browser for many Playwright checks and closes it at the end of checkLinks", async () => {
    // 403 from fetch -> every link is re-checked with Playwright
    state.fetchStatus = 403;
    const links = Array.from({ length: 20 }, (_, i) =>
      link(`https://blocked-${i}.example.com/page`),
    );

    const results = await checkLinks({ links });

    expect(results).toHaveLength(20);
    expect(state.visited).toHaveLength(20);
    expect(state.launches).toBe(1);
    expect(state.closes).toBe(1);
    expect(state.openPages).toBe(0);
  });

  it("does not launch a browser when nothing needs Playwright", async () => {
    state.fetchStatus = 200;
    await checkLinks({ links: [link("https://example.com/ok")] });
    expect(state.launches).toBe(0);
  });

  it("shares a single launch between concurrent callers and limits open pages", async () => {
    state.gotoDelayMs = 20;
    const results = await inRun(() =>
      Promise.all(
        Array.from({ length: 12 }, (_, i) => checkLinkWithPlaywright(`https://example.com/${i}`)),
      ),
    );

    expect(results.every((result) => result.ok)).toBe(true);
    expect(state.launches).toBe(1);
    expect(state.maxOpenPages).toBe(PLAYWRIGHT_CONCURRENCY_LIMIT);
  });

  it("limits open pages per run, runs do not share page slots", async () => {
    state.gotoDelayMs = 20;
    const runChecks = (prefix: string) =>
      inRun(() =>
        Promise.all(
          Array.from({ length: 12 }, (_, i) =>
            checkLinkWithPlaywright(`https://example.com/${prefix}${i}`),
          ),
        ),
      );
    vi.spyOn(console, "log").mockImplementation(() => {});

    await Promise.all([runChecks("a"), runChecks("b")]);

    expect(state.maxOpenPages).toBe(2 * PLAYWRIGHT_CONCURRENCY_LIMIT);
  });

  it("relaunches a crashed browser once and retries the check", async () => {
    const result = await inRun(async () => {
      await launchBrowser();
      state.crashNextContext = true;
      return checkLinkWithPlaywright("https://example.com/after-crash");
    });

    expect(result).toEqual({ ok: true, status: 200 });
    expect(state.launches).toBe(2);
    expect(state.visited).toEqual(["https://example.com/after-crash"]);
  });

  it("does not retry errors that are not crashes", async () => {
    await expect(
      inRun(() =>
        withPage(
          async () => {
            throw new Error("boom");
          },
          { timeout: 1000 },
        ),
      ),
    ).rejects.toThrow("boom");
    expect(state.launches).toBe(1);
    // The context is closed even when the check throws
    expect(state.openPages).toBe(0);
  });

  it("relaunches the browser when it crashes during navigation and retries the check", async () => {
    const result = await inRun(async () => {
      await launchBrowser();
      state.nextGotoFailure = "crash";
      return checkLinkWithPlaywright("https://example.com/crash");
    });

    expect(result).toEqual({ ok: true, status: 200 });
    expect(state.launches).toBe(2);
  });

  it("reports navigation errors as broken links (no relaunch)", async () => {
    state.nextGotoFailure = "error";

    const result = await inRun(() => checkLinkWithPlaywright("https://does-not-exist.example.com"));

    expect(result).toMatchObject({ ok: false, error: "broken link" });
    expect(!result.ok && result.errorDetail).toContain("ERR_NAME_NOT_RESOLVED");
    expect(state.launches).toBe(1);
  });

  it("reports browser launch failures as unexpected errors (not broken links)", async () => {
    state.failLaunch = "other";
    state.fetchStatus = 403;

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
        (result) => !result.result.ok && result.result.errorDetail?.includes("Failed to launch"),
      ),
    ).toBe(true);
    expect(state.installs).toBe(0);
  });

  it("installs Chromium when the browser executable is missing and retries the launch", async () => {
    state.failLaunch = "missing";

    const result = await inRun(() => checkLinkWithPlaywright("https://example.com/after-install"));

    expect(result).toEqual({ ok: true, status: 200 });
    expect(state.installs).toBe(1);
    expect(state.launches).toBe(2);
    expect(state.visited).toEqual(["https://example.com/after-install"]);
  });

  it("reports a missing browser as an unexpected error when Chromium install fails", async () => {
    state.failLaunch = "missing";
    state.failInstall = true;
    state.fetchStatus = 403;

    const [checked] = await checkLinks({ links: [link("https://blocked.example.com/a")] });

    expect(checked?.result).toMatchObject({
      ok: false,
      error: "unexpected error",
      errorDetail: "playwright install failed",
    });
    expect(state.installs).toBe(1);
    expect(state.launches).toBe(1);
  });
});

describe("browser belongs to the run", () => {
  it("closes the browser at the end of its own run, independently of other concurrent runs", async () => {
    let releaseSecond = () => {};
    state.gotoGates["https://example.com/second"] = new Promise((resolve) => {
      releaseSecond = resolve;
    });
    const first = inRun(() => checkLinkWithPlaywright("https://example.com/first"));
    const second = inRun(() => checkLinkWithPlaywright("https://example.com/second"));

    expect(await first).toEqual({ ok: true, status: 200 });
    expect(state.closes).toBe(1);
    // The second run still has its own (separate) browser open
    expect(state.launches).toBe(2);

    releaseSecond();
    expect(await second).toEqual({ ok: true, status: 200 });
    expect(state.closes).toBe(2);
  });

  it("closes the run's browser even when the run fails, a later run gets its own browser", async () => {
    await expect(
      inRun(async () => {
        await checkLinkWithPlaywright("https://example.com/a");
        throw new Error("run failed");
      }),
    ).rejects.toThrow("run failed");
    expect(state.launches).toBe(1);
    expect(state.closes).toBe(1);

    const result = await inRun(() => checkLinkWithPlaywright("https://example.com/later"));
    expect(result).toEqual({ ok: true, status: 200 });
    expect(state.launches).toBe(2);
    expect(state.closes).toBe(2);
  });
});

describe("request blocking", () => {
  type FakeRequest = {
    resourceType: string;
    url: string;
    // Top-level navigation (the link being checked) or an iframe navigation
    navigation?: "main" | "iframe";
  };

  // Runs requests through the route handler `withPage` registered, returns the URLs that were aborted
  const run = async (requests: FakeRequest[], failResponse = false) => {
    const aborted: string[] = [];
    await inRun(() =>
      withPage(
        async () => {
          for (const { resourceType, url, navigation } of requests) {
            await state.routeHandler?.({
              request: () => ({
                resourceType: () => resourceType,
                url: () => url,
                isNavigationRequest: () => navigation !== undefined,
                frame: () => ({ parentFrame: () => (navigation === "iframe" ? {} : null) }),
              }),
              abort: async () => {
                aborted.push(url);
                if (failResponse) throw new Error("Target closed");
              },
              continue: async () => {
                if (failResponse) throw new Error("Target closed");
              },
            });
          }
        },
        { timeout: 1000 },
      ),
    );
    return aborted;
  };

  const main = (url: string): FakeRequest => ({
    resourceType: "document",
    url,
    navigation: "main",
  });
  const sub = (resourceType: string, url: string): FakeRequest => ({ resourceType, url });

  it("blocks images, media and fonts, keeps scripts, styles and data requests", async () => {
    const heavy = ["image", "media", "font"].map((type) =>
      sub(type, `https://example.com/${type}`),
    );
    const light = ["script", "stylesheet", "xhr", "fetch"].map((type) =>
      sub(type, `https://example.com/${type}`),
    );

    const aborted = await run([main("https://example.com/"), ...heavy, ...light]);

    expect(aborted).toEqual(heavy.map((request) => request.url));
  });

  it("blocks analytics hosts and their subdomains, not look-alike hosts", async () => {
    const blocked = [
      "https://www.googletagmanager.com/gtm.js",
      "https://stats.g.doubleclick.net/r/collect",
      "https://api.segment.io/v1/t",
      "https://script.hotjar.com/modules.js",
    ];
    const allowed = [
      "https://notgoogletagmanager.com/x.js",
      "https://example.com/googletagmanager.com.js",
    ];

    const aborted = await run([
      main("https://example.com/"),
      ...[...blocked, ...allowed].map((url) => sub("script", url)),
    ]);

    expect(aborted).toEqual(blocked);
  });

  it("never blocks the checked link itself by type, but blocks analytics iframes", async () => {
    const iframe = "https://www.googletagmanager.com/ns.html";

    const aborted = await run([
      { resourceType: "image", url: "https://example.com/logo.png", navigation: "main" },
      { resourceType: "document", url: iframe, navigation: "iframe" },
    ]);

    expect(aborted).toEqual([iframe]);
  });

  it("does not block a vendor's own hosts when the checked page is hosted by it", async () => {
    const aborted = await run([
      main("https://segment.com/docs/"),
      sub("script", "https://cdn.segment.com/app.js"),
      sub("script", "https://www.googletagmanager.com/gtm.js"),
      sub("image", "https://segment.com/logo.png"),
    ]);

    expect(aborted).toEqual([
      "https://www.googletagmanager.com/gtm.js",
      "https://segment.com/logo.png",
    ]);
  });

  it("tracks the checked page per page and follows redirects of the main navigation", async () => {
    const script = sub("script", "https://cdn.segment.com/analytics.js");

    // A previous segment.com page does not leak into the next page
    await run([main("https://segment.com/")]);
    expect(await run([main("https://example.com/"), script])).toEqual([script.url]);

    // A redirect to the vendor makes it the checked page
    expect(
      await run([main("https://example.com/"), main("https://segment.com/docs"), script]),
    ).toEqual([]);
  });

  it("does not throw on invalid request URLs", async () => {
    expect(await run([sub("script", "not a url")])).toEqual([]);
  });

  it("ignores errors when the page is already closed", async () => {
    const requests = [
      sub("font", "https://example.com/a.woff2"),
      sub("script", "https://example.com/a.js"),
    ];
    await expect(run(requests, true)).resolves.toEqual(["https://example.com/a.woff2"]);
  });
});

describe("installPlaywrightChromium()", () => {
  const spawnResult = (result: { status: number | null; error?: Error }) => vi.fn(() => result);

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("runs the playwright CLI of this package", () => {
    const spawn = spawnResult({ status: 0 });
    installPlaywrightChromium(spawn);
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringMatching(/playwright[\\/]cli\.js$/), "install", "chromium"],
      { stdio: "inherit" },
    );
  });

  it("throws when the install exits with an error status", () => {
    expect(() => installPlaywrightChromium(spawnResult({ status: 1 }))).toThrow(
      "playwright install chromium failed (exit 1)",
    );
  });

  it("throws the spawn error when the CLI can't start", () => {
    const error = new Error("spawn ENOENT");
    expect(() => installPlaywrightChromium(spawnResult({ status: null, error }))).toThrow(error);
  });
});
