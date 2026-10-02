import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as cheerio from "cheerio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkCheckResult, LinkWithResult } from "./types";

/**
 * Offline tests for `link.ts`: `fetch`, the GitHub API check and Playwright are all mocked.
 */

const { checkLinkWithGithubApiMock, playwrightState } = vi.hoisted(() => ({
  checkLinkWithGithubApiMock: vi.fn(),
  playwrightState: {
    // URLs Playwright navigated to
    visited: [] as string[],
    // Selectors Playwright waited for
    selectors: [] as string[],
    // HTML the fake browser "renders"
    html: "",
    // HTML per navigated URL (hash included), falls back to `html`
    htmlByUrl: {} as Record<string, string>,
    status: 200,
    // Statuses of the next navigations (one per `goto`), then `status`
    statuses: [] as number[],
    // Headers of the navigation response (lowercase names, like Playwright)
    headers: {} as Record<string, string>,
    // Simulated navigation time
    gotoDelayMs: 0,
    // Time of the last navigation per URL (`Date.now()`, simulated with fake timers)
    visitedAt: {} as Record<string, number>,
    // Final URL of a navigation (after redirects) per navigated URL, falls back to the navigated URL
    finalUrlByUrl: {} as Record<string, string>,
    // Timeouts passed to `goto` and set as page defaults
    gotoTimeouts: [] as Array<number | undefined>,
    pageTimeouts: [] as number[],
    // HTML per navigated URL rendered `afterMs` after the navigation (anchors rendered late, e.g. by a timer on an
    // already loaded and quiet page), falls back to the above before that. For tests with fake timers.
    lateHtmlByUrl: {} as Record<string, { html: string; afterMs: number }>,
    // Timeouts of hash waits
    hashTimeouts: [] as Array<number | undefined>,
    // The navigation response body never ends (Playwright has no timeout for it)
    responseBodyHangs: false,
    // A missing selector times out after its whole timeout (instead of right away), for tests with fake timers
    waitForTakesTimeout: false,
  },
}));

vi.mock("./github/gh_check_link", () => ({
  checkLinkWithGithubApi: checkLinkWithGithubApiMock,
}));

// Fake Playwright browser: records navigations, "renders" `playwrightState.html` and evaluates selectors with cheerio
vi.mock("playwright", () => ({
  chromium: {
    launch: async () => ({
      close: async () => {},
      on: () => {},
      isConnected: () => true,
      newContext: async () => ({
        route: async () => {},
        close: async () => {},
        newPage: async () => {
          let currentUrl = "";
          let navigatedAt = 0;
          return {
            isClosed: () => false,
            setDefaultTimeout: (timeout: number) => playwrightState.pageTimeouts.push(timeout),
            setDefaultNavigationTimeout: (timeout: number) =>
              playwrightState.pageTimeouts.push(timeout),
            goto: async (url: string, options?: { timeout?: number }) => {
              currentUrl = url;
              playwrightState.visited.push(url);
              playwrightState.visitedAt[url] = Date.now();
              playwrightState.gotoTimeouts.push(options?.timeout);
              if (playwrightState.gotoDelayMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, playwrightState.gotoDelayMs));
              }
              navigatedAt = Date.now();
              const status = playwrightState.statuses.shift() ?? playwrightState.status;
              return {
                status: () => status,
                statusText: () => "",
                url: () => playwrightState.finalUrlByUrl[url] ?? url,
                headers: () => playwrightState.headers,
                text: () =>
                  playwrightState.responseBodyHangs
                    ? new Promise<string>(() => {})
                    : Promise.resolve("Forbidden page"),
              };
            },
            locator: (selector: string) => ({
              first: () => ({
                waitFor: async (options?: { timeout?: number }) => {
                  playwrightState.selectors.push(selector);
                  playwrightState.hashTimeouts.push(options?.timeout);
                  const matches = (html: string) => cheerio.load(html)(selector).length > 0;
                  // Throws for invalid selectors, like Playwright would
                  if (matches(playwrightState.htmlByUrl[currentUrl] ?? playwrightState.html)) {
                    return;
                  }
                  const late = playwrightState.lateHtmlByUrl[currentUrl];
                  const lateIn = late ? navigatedAt + late.afterMs - Date.now() : Number.NaN;
                  if (late && matches(late.html) && lateIn <= (options?.timeout ?? 0)) {
                    await new Promise((resolve) => setTimeout(resolve, Math.max(0, lateIn)));
                    return;
                  }
                  if (playwrightState.waitForTakesTimeout) {
                    await new Promise((resolve) => setTimeout(resolve, options?.timeout));
                  }
                  const error = new Error("Timeout");
                  error.name = "TimeoutError";
                  throw error;
                },
              }),
            }),
          };
        },
      }),
    }),
  },
}));

import { checkLinkWithFetch } from "./fetch_check";
import { setServerErrorRetryDelays } from "./http";
import { HostLimiter } from "./limiter";
import { checkLinks, interleaveByHost, shouldRecheckWithPlaywright } from "./link";
import { getSpecialFragmentNote } from "./link_common";
import { checkLinkWithPlaywright } from "./playwright_check";
import { withRun } from "./run";
import { getRunContext } from "./run_context";
import { setHostLimiter } from "./utils";

const hashesHtml = readFileSync(join(import.meta.dirname, "__fixtures__", "hashes.html"), "utf8");

type FetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>;

const stubFetch = (handler: FetchHandler) => {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init ?? {}),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const link = (href: string, page = "https://example.com/page") => ({ href, page, text: "link" });

beforeEach(() => {
  playwrightState.visited = [];
  playwrightState.selectors = [];
  playwrightState.html = "<html><body></body></html>";
  playwrightState.htmlByUrl = {};
  playwrightState.gotoDelayMs = 0;
  playwrightState.visitedAt = {};
  playwrightState.finalUrlByUrl = {};
  playwrightState.gotoTimeouts = [];
  playwrightState.pageTimeouts = [];
  playwrightState.lateHtmlByUrl = {};
  playwrightState.responseBodyHangs = false;
  playwrightState.hashTimeouts = [];
  playwrightState.waitForTakesTimeout = false;
  playwrightState.status = 200;
  playwrightState.statuses = [];
  playwrightState.headers = {};
  checkLinkWithGithubApiMock.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  // Host pauses (server error backoffs) don't leak into other tests
  setHostLimiter(undefined);
  setServerErrorRetryDelays(undefined);
});

describe("checkLinks() deduplication", () => {
  it("checks each href only once, even when concurrent tasks check the same href", async () => {
    const fetchMock = stubFetch(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(null, { status: 200 });
    });
    const links = Array.from({ length: 10 }, (_, i) =>
      link("https://example.com/same", `https://example.com/p${i}`),
    );

    const { results, errors } = await checkLinks({ links });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(0);
    expect(results).toHaveLength(10);
    expect(results.every((r) => r.result.ok)).toBe(true);
    // Every link keeps its own page
    expect(new Set(results.map((r) => r.page)).size).toBe(10);
  });

  it("checks each GitHub href only once with the GitHub API", async () => {
    checkLinkWithGithubApiMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ok: true, status: 200 };
    });
    const links = Array.from({ length: 5 }, () => link("https://github.com/owner/repo/issues/1"));

    const { results } = await checkLinks({ links });

    expect(checkLinkWithGithubApiMock).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(5);
  });

  it("checks each href only once with Playwright", async () => {
    stubFetch(() => new Response(null, { status: 403 }));
    const links = Array.from({ length: 5 }, () => link("https://blocked.example.com"));

    const { results } = await checkLinks({ links });

    expect(playwrightState.visited).toEqual(["https://blocked.example.com"]);
    expect(results).toHaveLength(5);
  });
});

describe("checkLinks() Playwright escalation", () => {
  const githubApiCases: Array<[string, LinkCheckResult, boolean]> = [
    [
      "404 from the API",
      { ok: false, error: "broken link", status: 404, errorDetail: "Issue not found" },
      false,
    ],
    ["hash not found from the API", { ok: false, error: "hash not found", status: 200 }, false],
    ["unexpected API error", { ok: false, error: "unexpected error", status: 400 }, true],
  ];

  it.each(githubApiCases)(
    "GitHub API result: %s -> re-checked with Playwright: %s",
    async (_name, apiResult, escalate) => {
      checkLinkWithGithubApiMock.mockResolvedValue(apiResult);
      const href = "https://github.com/owner/repo/issues/999";

      const { results } = await checkLinks({ links: [link(href)] });

      expect(playwrightState.visited).toEqual(escalate ? [href] : []);
      expect(results).toHaveLength(1);
      // The definitive API result is reported as-is.
      // Escalated links get the Playwright result (the fake page has no hash to look for)
      const expected = escalate ? { ok: true, status: 200 } : apiResult;
      expect(results[0]!.result).toEqual(expected);
    },
  );

  it("checks GitHub code line links with the GitHub API, without the browser", async () => {
    const href = "https://github.com/owner/repo/blob/main/a.js#L999";
    const apiResult: LinkCheckResult = {
      ok: false,
      error: "hash not found",
      status: 200,
      errorDetail: "a.js has only 3 lines",
    };
    checkLinkWithGithubApiMock.mockResolvedValue(apiResult);

    const { results } = await checkLinks({ links: [link(href), link(href)] });

    expect(checkLinkWithGithubApiMock).toHaveBeenCalledTimes(1);
    expect(checkLinkWithGithubApiMock).toHaveBeenCalledWith(href);
    expect(playwrightState.visited).toEqual([]);
    expect(results.map((r) => r.result)).toEqual([apiResult, apiResult]);
  });

  it("falls back to the browser for GitHub code line links the API can't check (no token, rate limited)", async () => {
    const href = "https://github.com/owner/repo/blob/main/a.js#L2";
    checkLinkWithGithubApiMock.mockResolvedValue({
      ok: false,
      error: "unexpected error",
      errorDetail: "Error: GH_TOKEN is not set",
    });
    playwrightState.html = '<div data-line-number="1"></div><div data-line-number="2"></div>';

    const { results } = await checkLinks({ links: [link(href)] });

    expect(playwrightState.visited).toEqual([href]);
    expect(results[0]!.result).toEqual({ ok: true, status: 200 });
  });

  it("reports unparsable URLs as broken without any request or Playwright re-check", async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 200 }));

    const { results } = await checkLinks({ links: [link("not a url")] });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(playwrightState.visited).toEqual([]);
    expect(results[0]!.result).toMatchObject({ ok: false, error: "broken link" });
  });

  it.each(["tel:+123", "javascript:void(0)", "data:text/plain,hi"])(
    "never fetches or re-checks non-http(s) URLs like %s",
    async (href) => {
      const fetchMock = stubFetch(() => new Response(null, { status: 200 }));

      const { results } = await checkLinks({ links: [link(href)] });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(playwrightState.visited).toEqual([]);
      expect(results[0]!.result).toMatchObject({ ok: false, error: "broken link" });
    },
  );

  const fetchCases: Array<[string, FetchHandler, boolean]> = [
    ["404", () => new Response("Not found", { status: 404 }), false],
    ["410", () => new Response("Gone", { status: 410 }), false],
    ["403 (bot blocking)", () => new Response(null, { status: 403 }), true],
    ["401", () => new Response(null, { status: 401 }), true],
    ["429 without Retry-After", () => new Response(null, { status: 429 }), true],
    ["503", () => new Response(null, { status: 503 }), true],
    [
      "network error",
      () => {
        throw new TypeError("fetch failed");
      },
      true,
    ],
  ];

  it.each(fetchCases)(
    "fetch result: %s -> re-checked with Playwright: %s",
    async (_name, handler, escalate) => {
      // No backoff for the 503 case
      setServerErrorRetryDelays([0]);
      stubFetch(handler);
      const href = "https://example.com/some/page";

      const { results } = await checkLinks({ links: [link(href)] });

      expect(playwrightState.visited).toEqual(escalate ? [href] : []);
      expect(results).toHaveLength(1);
    },
  );

  it("re-checks 'hash not found' from fetch with Playwright (client-side rendered page)", async () => {
    stubFetch(() => new Response("<html><body>Loading...</body></html>", { status: 200 }));
    playwrightState.html = '<html><body><h2 id="rendered">Rendered</h2></body></html>';
    const href = "https://example.com/spa#rendered";

    const { results } = await checkLinks({ links: [link(href)] });

    expect(playwrightState.visited).toEqual([href]);
    expect(results[0]!.result).toEqual({ ok: true, status: 200 });
  });

  it("checks GitHub wiki links with fetch", async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 200 }));

    await checkLinks({ links: [link("https://github.com/owner/repo/wiki/Page")] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(checkLinkWithGithubApiMock).not.toHaveBeenCalled();
  });

  it("checks GitHub's own pages with fetch (re-checked with Playwright if blocked), not as accounts", async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 429 }));
    const hrefs = ["https://github.com/features", "https://github.com/topics/javascript"];

    const { results } = await checkLinks({ links: hrefs.map((href) => link(href)) });

    expect(checkLinkWithGithubApiMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(playwrightState.visited.toSorted()).toEqual(hrefs);
    expect(results.every((r) => r.result.ok)).toBe(true);
  });

  it("shouldRecheckWithPlaywright() never re-checks OK results", () => {
    expect(shouldRecheckWithPlaywright({ ok: true, status: 200 }, "fetch")).toBe(false);
    expect(shouldRecheckWithPlaywright({ ok: true, status: 200 }, "github-api")).toBe(false);
  });
});

describe("checkLinkWithFetch()", () => {
  it("reports an unparsable URL as broken link instead of throwing", async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 200 }));

    const result = await checkLinkWithFetch("not a url");

    expect(result).toMatchObject({ ok: false, error: "broken link" });
    expect(!result.ok && result.errorDetail).toContain("Invalid URL");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sets a request timeout", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = stubFetch(() => new Response(null, { status: 200 }));

    await checkLinkWithFetch("https://example.com");

    expect(timeoutSpy).toHaveBeenCalledWith(20000);
    expect(fetchMock.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports a timed out request as broken link", async () => {
    stubFetch(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });

    const result = await checkLinkWithFetch("https://example.com/slow");

    expect(result).toMatchObject({ ok: false, error: "broken link" });
    expect(!result.ok && result.errorDetail).toContain("TimeoutError");
  });

  it.each([405, 403, 501])("retries once with GET when HEAD returns %s", async (status) => {
    const fetchMock = stubFetch((_url, init) =>
      init.method === "HEAD" ? new Response(null, { status }) : new Response("ok", { status: 200 }),
    );

    const result = await checkLinkWithFetch("https://example.com/no-head");

    expect(result).toEqual({ ok: true, status: 200 });
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["HEAD", "GET"]);
  });

  it("fails when GET also fails after HEAD", async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 405 }));

    const result = await checkLinkWithFetch("https://example.com/no-head");

    expect(result).toMatchObject({ ok: false, error: "broken link", status: 405 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([400, 404, 410, 500, 503])(
    "retries once with GET when HEAD returns %s (servers answering HEAD differently)",
    async (status) => {
      // support.google.com and chatgpt.com answer 404 to HEAD and 200 to GET
      const fetchMock = stubFetch((_url, init) =>
        init.method === "HEAD"
          ? new Response(null, { status })
          : new Response("ok", { status: 200 }),
      );

      const result = await checkLinkWithFetch("https://support.example.com/answer/1");

      expect(result).toEqual({ ok: true, status: 200 });
      expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["HEAD", "GET"]);
    },
  );

  it("reports 404 when GET also returns 404 after HEAD", async () => {
    const fetchMock = stubFetch(() => new Response("Not found", { status: 404 }));

    const result = await checkLinkWithFetch("https://example.com/missing");

    expect(result).toMatchObject({ ok: false, error: "broken link", status: 404 });
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["HEAD", "GET"]);
  });

  it("does not retry with GET when HEAD succeeds", async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 200 }));

    await checkLinkWithFetch("https://example.com/ok");

    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["HEAD"]);
  });

  it("does not retry with GET when HEAD is rate limited (429)", async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 429 }));

    const result = await checkLinkWithFetch("https://example.com/limited");

    expect(result).toMatchObject({ ok: false, error: "broken link", status: 429 });
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["HEAD"]);
  });

  it.each(["#zippy=%2Cdata-sharing", "#zippy="])(
    "accepts Google Help accordion fragment %s without an element id",
    async (hash) => {
      stubFetch(() => new Response("<html><body></body></html>", { status: 200 }));

      const result = await checkLinkWithFetch(`https://support.google.com/answer/10787469${hash}`);

      expect(result).toEqual({ ok: true, status: 200, note: "Google Help accordion state" });
    },
  );

  it("still checks zippy fragments on other hosts", async () => {
    stubFetch(() => new Response("<html><body></body></html>", { status: 200 }));

    const result = await checkLinkWithFetch("https://example.com/help#zippy=%2Csection");

    expect(result).toEqual({ ok: false, status: 200, error: "hash not found" });
  });

  it("getSpecialFragmentNote() accepts zippy fragments on Google Help only", () => {
    expect(getSpecialFragmentNote("zippy=,a", "https://support.google.com/x#zippy=,a")).toBe(
      "Google Help accordion state",
    );
    expect(getSpecialFragmentNote("zippy=,a", "https://SUPPORT.Google.com/x")).toBe(
      "Google Help accordion state",
    );
    expect(getSpecialFragmentNote("zippy=,a", "https://example.com/x")).toBeUndefined();
    expect(
      getSpecialFragmentNote("zippy=,a", "https://support.google.com.evil.com/x"),
    ).toBeUndefined();
    expect(getSpecialFragmentNote("zippy=,a", "https://google.com/x")).toBeUndefined();
    // Not host-specific
    expect(getSpecialFragmentNote("/", "https://example.com/x")).toBe("Accidental hash");
    expect(getSpecialFragmentNote(":~:text=a", "https://example.com/x")).toBe("Text Fragment");
  });

  it("still checks hashes that only contain 'zippy' later on", async () => {
    stubFetch(() => new Response("<html><body></body></html>", { status: 200 }));

    const result = await checkLinkWithFetch("https://example.com/page#not-zippy=1");

    expect(result).toEqual({ ok: false, status: 200, error: "hash not found" });
  });

  const existingHashes = [
    "#version-1.2.3",
    "#1-create-an-account",
    "#namespace:item",
    "#path/to/section",
    "#it's-quoted",
    "#say-%22hi%22",
    "#caf%C3%A9",
    "#legacy-anchor",
    "#InStAlLaTiOn",
  ];

  it.each(existingHashes)(
    "finds hash %s with special characters in server-rendered HTML",
    async (hash) => {
      stubFetch(() => new Response(hashesHtml, { status: 200 }));

      const result = await checkLinkWithFetch(`https://example.com/docs${hash}`);

      expect(result).toEqual({ ok: true, status: 200 });
    },
  );

  it("reports missing hashes as 'hash not found' (not 'broken link')", async () => {
    stubFetch(() => new Response(hashesHtml, { status: 200 }));

    const result = await checkLinkWithFetch("https://example.com/docs#version-9.9.9");

    expect(result).toEqual({ ok: false, status: 200, error: "hash not found" });
  });
});

describe("checkLinkWithPlaywright() hash check", () => {
  it.each([
    "#version-1.2.3",
    "#1-create-an-account",
    "#say-%22hi%22",
    "#caf%C3%A9",
    "#legacy-anchor",
  ])("builds a valid selector for %s", async (hash) => {
    playwrightState.html = hashesHtml;

    const result = await checkLinkWithPlaywright(`https://example.com/docs${hash}`);

    expect(result).toEqual({ ok: true, status: 200 });
  });

  it("reports missing hashes as 'hash not found'", async () => {
    playwrightState.html = hashesHtml;

    const result = await checkLinkWithPlaywright("https://example.com/docs#it's-%22missing%22");

    expect(result).toEqual({ ok: false, status: 200, error: "hash not found" });
  });

  it("accepts Google Help accordion fragments without waiting for an element", async () => {
    const result = await checkLinkWithPlaywright(
      "https://support.google.com/answer/10787469#zippy=%2Cdata-sharing",
    );

    expect(result).toEqual({ ok: true, status: 200, note: "Google Help accordion state" });
    expect(playwrightState.selectors).toEqual([]);
  });

  it("still checks zippy fragments on other hosts", async () => {
    const result = await checkLinkWithPlaywright("https://example.com/help#zippy=%2Csection");

    expect(result).toEqual({ ok: false, status: 200, error: "hash not found" });
    expect(playwrightState.selectors).not.toEqual([]);
  });

  it("finds a fast anchor with the short wait, without the long wait", async () => {
    playwrightState.html = '<div id="fast"></div>';

    const result = await withRun(async () => {
      const checked = await checkLinkWithPlaywright("https://example.com/docs#fast");
      expect(getRunContext()!.metrics.counters.playwrightLongHashWaits ?? 0).toBe(0);
      return checked;
    });

    expect(result).toEqual({ ok: true, status: 200 });
    expect(playwrightState.hashTimeouts).toEqual([3000]);
  });

  /** Checks `url` with fake timers, returns the result and how long the check took (simulated time) */
  const checkWithFakeTimers = async (url: string) => {
    vi.useFakeTimers();
    try {
      playwrightState.waitForTakesTimeout = true;
      const start = Date.now();
      let finishedAt = Number.NaN;
      const promise = checkLinkWithPlaywright(url).then((r) => {
        finishedAt = Date.now();
        return r;
      });
      await vi.advanceTimersByTimeAsync(60_000);
      return { result: await promise, took: finishedAt - start };
    } finally {
      vi.useRealTimers();
    }
  };

  it("waits longer for an anchor rendered late (same navigation)", async () => {
    const url = "https://docs.example.com/reference/get-event#response-ip-info-v6-address";
    // Added by a timer 4s after the navigation, on an already loaded and quiet page (e.g. Mintlify expands nested
    // response fields on hash navigation)
    playwrightState.lateHtmlByUrl = {
      [url]: { html: '<div id="response-ip-info-v6-address"></div>', afterMs: 4000 },
    };

    const { result, took } = await checkWithFakeTimers(url);

    expect(result).toEqual({ ok: true, status: 200 });
    expect(playwrightState.visited).toEqual([url]);
    // Found as soon as it appears, the rest of the budget is not waited
    expect(took).toBe(4000);
    expect(playwrightState.hashTimeouts).toEqual([3000, 12_000]);
  });

  it("waits for a missing anchor until the 15s budget is used up (regular wait included)", async () => {
    const { result, took } = await checkWithFakeTimers("https://example.com/docs#never");

    expect(result).toEqual({ ok: false, status: 200, error: "hash not found" });
    expect(playwrightState.visited).toEqual(["https://example.com/docs#never"]);
    // The regular wait is part of the overall budget (not 15s on top of it)
    expect(playwrightState.hashTimeouts).toEqual([3000, 12_000]);
    expect(took).toBe(15_000);
  });

  it("reports an anchor rendered after the budget as missing", async () => {
    const url = "https://example.com/docs#too-late";
    playwrightState.lateHtmlByUrl = {
      [url]: { html: '<div id="too-late"></div>', afterMs: 16_000 },
    };

    const { result, took } = await checkWithFakeTimers(url);

    expect(result).toEqual({ ok: false, status: 200, error: "hash not found" });
    expect(took).toBe(15_000);
  });

  it("reports a forbidden page with its body", async () => {
    playwrightState.status = 403;

    const result = await checkLinkWithPlaywright("https://example.com/docs#a");

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: "could not check",
      errorDetail: " Forbidden page",
    });
  });

  it("does not wait forever for the body of a forbidden page", async () => {
    playwrightState.status = 403;
    playwrightState.responseBodyHangs = true;

    const { result, took } = await checkWithFakeTimers("https://example.com/docs#a");

    expect(result).toEqual({ ok: false, status: 403, error: "could not check", errorDetail: " " });
    expect(took).toBe(30_000);
  });

  describe("GitHub code line links", () => {
    const file = "https://github.com/owner/repo/blob/main/a.js";
    const codeView =
      '<div data-line-number="1"></div><div data-line-number="2"></div><div data-line-number="3"></div>';

    it.each(["#L2", "#L1-L3"])("finds line %s in the code view", async (hash) => {
      playwrightState.html = codeView;

      const result = await checkLinkWithPlaywright(`${file}${hash}`);

      expect(result).toEqual({ ok: true, status: 200 });
    });

    it.each(["#L99", "#L99-L120"])(
      "reports line %s beyond the end of the file without the long wait",
      async (hash) => {
        playwrightState.html = codeView;

        const result = await withRun(async () => {
          const checked = await checkLinkWithPlaywright(`${file}${hash}`);
          expect(getRunContext()!.metrics.counters.playwrightLongHashWaits ?? 0).toBe(0);
          return checked;
        });

        expect(result).toEqual({ ok: false, status: 200, error: "hash not found" });
        // The code view (or the line) first, then the line itself briefly
        expect(playwrightState.selectors.at(0)).toContain("[data-line-number]");
        expect(playwrightState.selectors.at(1)).toContain('[data-line-number="99"]');
        expect(playwrightState.selectors.at(1)).not.toContain("[data-line-number],");
        expect(playwrightState.hashTimeouts).toEqual([15000, 3000]);
      },
    );

    it("reports a line as not found when the code view never renders", async () => {
      playwrightState.html = "<div>This file is too big to show</div>";

      const result = await checkLinkWithPlaywright(`${file}#L2`);

      expect(result).toEqual({ ok: false, status: 200, error: "hash not found" });
      expect(playwrightState.hashTimeouts).toEqual([15000]);
    });
  });
});

describe("checkLinks() grouping by page (URL without hash)", () => {
  it("fetches a page once for all its hashes and checks every hash against the same HTML", async () => {
    const fetchMock = stubFetch(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(hashesHtml, { status: 200 });
    });
    const hrefs = ["#version-1.2.3", "#legacy-anchor", "#caf%C3%A9", "#does-not-exist", ""].map(
      (hash) => `https://example.com/docs${hash}`,
    );
    // Every href appears twice (on different source pages)
    const links = [...hrefs, ...hrefs].map((href, i) =>
      link(href, `https://example.com/source-${i}`),
    );

    const { results, errors } = await checkLinks({ links });

    expect(errors).toHaveLength(0);
    // One GET for the page, also used by the link without a hash (no extra HEAD request)
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]?.method).toBe("GET");
    expect(results).toHaveLength(10);
    const resultByHref = new Map(results.map((r) => [r.href, r.result]));
    expect(resultByHref.get("https://example.com/docs#version-1.2.3")).toEqual({
      ok: true,
      status: 200,
    });
    expect(resultByHref.get("https://example.com/docs#caf%C3%A9")).toEqual({
      ok: true,
      status: 200,
    });
    expect(resultByHref.get("https://example.com/docs")).toEqual({ ok: true, status: 200 });
    // Re-checked with Playwright (empty page), still not found
    expect(resultByHref.get("https://example.com/docs#does-not-exist")).toEqual({
      ok: false,
      status: 200,
      error: "hash not found",
    });
    // Every link keeps its own source page
    expect(new Set(results.map((r) => r.page)).size).toBe(10);
  });

  it("uses HEAD for pages that are never linked with a hash", async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 200 }));

    await checkLinks({ links: [link("https://example.com/a"), link("https://example.com/b")] });

    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["HEAD", "HEAD"]);
  });

  it("reports a broken page for every hash pointing to it (one request)", async () => {
    const fetchMock = stubFetch(() => new Response("Not found", { status: 404 }));
    const links = ["#a", "#b", "#c"].map((hash) => link(`https://example.com/gone${hash}`));

    const { results } = await checkLinks({ links });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.result)).toEqual(
      Array(3).fill(expect.objectContaining({ ok: false, error: "broken link", status: 404 })),
    );
  });

  it("navigates once with Playwright for all hashes of a page and checks each hash in the same DOM", async () => {
    // Client-side rendered page: the server HTML has no anchors
    stubFetch(() => new Response("<html><body>Loading...</body></html>", { status: 200 }));
    playwrightState.html = '<html><body><h2 id="one">One</h2><a name="two"></a></body></html>';
    const links = ["#one", "#two", "#three"].map((hash) => link(`https://example.com/spa${hash}`));

    const { results } = await checkLinks({ links });

    // One shared navigation, plus a dedicated one for the hash missing in the shared DOM
    expect(playwrightState.visited).toEqual([
      "https://example.com/spa#one",
      "https://example.com/spa#three",
    ]);
    const resultByHref = new Map(results.map((r) => [r.href, r.result]));
    expect(resultByHref.get("https://example.com/spa#one")).toEqual({ ok: true, status: 200 });
    expect(resultByHref.get("https://example.com/spa#two")).toEqual({ ok: true, status: 200 });
    expect(resultByHref.get("https://example.com/spa#three")).toEqual({
      ok: false,
      status: 200,
      error: "hash not found",
    });
  });

  it("checks GitHub code line links to the same file with one navigation (browser fallback)", async () => {
    playwrightState.html =
      '<html><body><div data-line-number="5"></div><div data-line-number="6"></div></body></html>';
    const file = "https://github.com/owner/repo/blob/main/a.js";
    const links = ["#L5", "#L6", "#L5-L6", "#L99"].map((hash) => link(`${file}${hash}`));
    // The API can't check them (e.g. no `GH_TOKEN`), they fall back to the browser
    checkLinkWithGithubApiMock.mockResolvedValue({ ok: false, error: "unexpected error" });

    const { results } = await checkLinks({ links });

    // Found line numbers share one navigation, the missing one gets a dedicated navigation
    expect(playwrightState.visited).toEqual([`${file}#L5`, `${file}#L99`]);
    expect(results.filter((r) => r.result.ok).map((r) => r.href)).toEqual([
      `${file}#L5`,
      `${file}#L6`,
      `${file}#L5-L6`,
    ]);
    expect(results.find((r) => r.href === `${file}#L99`)?.result).toMatchObject({
      error: "hash not found",
    });
  });

  it("navigates once per page with Playwright", async () => {
    stubFetch(() => new Response(null, { status: 403 }));
    const links = [
      link("https://blocked.example.com/a"),
      link("https://blocked.example.com/a#x"),
      link("https://blocked.example.com/b"),
    ];

    const { results } = await checkLinks({ links });

    // One navigation per page, plus a dedicated one for `#x` (not in the shared DOM of page `a`)
    expect(playwrightState.visited).toEqual([
      "https://blocked.example.com/a",
      "https://blocked.example.com/b",
      "https://blocked.example.com/a#x",
    ]);
    expect(results).toHaveLength(3);
  });
});

describe("checkLinks() Playwright hash fallback", () => {
  it("re-checks a hash missing in the shared DOM with a dedicated navigation (SPA tabs)", async () => {
    stubFetch(() => new Response("<html><body>Loading...</body></html>", { status: 200 }));
    // The SPA renders a different tab per hash
    playwrightState.htmlByUrl = {
      "https://example.com/app#tab-a": '<div id="tab-a"></div>',
      "https://example.com/app#tab-b": '<div id="tab-b"></div>',
    };
    const links = ["#tab-a", "#tab-b", "#missing"].map((hash) =>
      link(`https://example.com/app${hash}`),
    );

    const { results, errors } = await withRun(async () => {
      const checked = await checkLinks({ links });
      expect(getRunContext()!.metrics.counters).toMatchObject({
        playwrightNavigations: 3,
        playwrightHashFallbacks: 2,
      });
      return checked;
    });

    expect(errors).toHaveLength(0);
    const resultByHref = new Map(results.map((r) => [r.href, r.result]));
    expect(resultByHref.get("https://example.com/app#tab-a")).toEqual({ ok: true, status: 200 });
    expect(resultByHref.get("https://example.com/app#tab-b")).toEqual({ ok: true, status: 200 });
    expect(resultByHref.get("https://example.com/app#missing")).toEqual({
      ok: false,
      status: 200,
      error: "hash not found",
    });
    expect(playwrightState.visited).toEqual([
      "https://example.com/app#tab-a",
      "https://example.com/app#tab-b",
      "https://example.com/app#missing",
    ]);
  });

  it("does not time out a page group whose fallback navigations together take longer than the task timeout", async () => {
    vi.useFakeTimers();
    try {
      stubFetch(() => new Response("<html><body>Loading...</body></html>", { status: 200 }));
      // Every tab is only rendered on its own URL: 1 shared navigation + 11 fallbacks, 5 page slots,
      // 25s per navigation (each within its own 30s timeout) -> about 100s in total, more than TASK_TIMEOUT (80s)
      playwrightState.gotoDelayMs = 25_000;
      const hrefs = Array.from({ length: 12 }, (_, i) => `https://example.com/app#tab-${i}`);
      playwrightState.htmlByUrl = Object.fromEntries(
        hrefs.map((href, i) => [href, `<div id="tab-${i}"></div>`]),
      );

      const promise = checkLinks({ links: hrefs.map((href) => link(href)) });
      await vi.advanceTimersByTimeAsync(300_000);
      const { results, errors } = await promise;

      expect(errors).toHaveLength(0);
      expect(results).toHaveLength(12);
      expect(results.every((r) => r.result.ok)).toBe(true);
      expect(playwrightState.visited).toHaveLength(12);
      // Every navigation is bounded on its own
      expect(playwrightState.gotoTimeouts).toEqual(Array(12).fill(30000));
      expect(new Set(playwrightState.pageTimeouts)).toEqual(new Set([30000]));
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for late anchors of every hash of a page (shared navigation and dedicated fallbacks)", async () => {
    stubFetch(() => new Response("<html><body>Loading...</body></html>", { status: 200 }));
    const page = "https://docs.example.com/reference/get-event";
    const hashes = ["#response-a", "#response-b", "#response-c", "#missing"];
    // Every field is only expanded (and gets its id) when the page is opened with its hash, a few seconds later
    playwrightState.lateHtmlByUrl = Object.fromEntries(
      hashes
        .slice(0, 3)
        .map((hash) => [
          `${page}${hash}`,
          { html: `<div id="${hash.slice(1)}"></div>`, afterMs: 4000 },
        ]),
    );

    vi.useFakeTimers();
    let results: LinkWithResult[];
    try {
      const promise = withRun(async () => {
        const checked = await checkLinks({ links: hashes.map((hash) => link(`${page}${hash}`)) });
        expect(getRunContext()!.metrics.counters).toMatchObject({
          playwrightNavigations: 4,
          playwrightHashFallbacks: 3,
          playwrightLongHashWaits: 4,
        });
        return checked;
      });
      await vi.advanceTimersByTimeAsync(120_000);
      ({ results } = await promise);
    } finally {
      vi.useRealTimers();
    }

    const resultByHref = new Map(results.map((r) => [r.href, r.result]));
    for (const hash of hashes.slice(0, 3)) {
      expect(resultByHref.get(`${page}${hash}`)).toEqual({ ok: true, status: 200 });
    }
    expect(resultByHref.get(`${page}#missing`)).toEqual({
      ok: false,
      status: 200,
      error: "hash not found",
    });
    // One navigation per hash, no extra navigation for the long wait
    expect(playwrightState.visited.toSorted()).toEqual(
      hashes.map((hash) => `${page}${hash}`).toSorted(),
    );
  });

  it("does not add navigations when every hash is in the shared DOM", async () => {
    stubFetch(() => new Response("<html><body>Loading...</body></html>", { status: 200 }));
    playwrightState.html = '<div id="a"></div><div id="b"></div>';

    await checkLinks({ links: [link("https://example.com/p#a"), link("https://example.com/p#b")] });

    expect(playwrightState.visited).toEqual(["https://example.com/p#a"]);
  });
});

describe("server errors (502, 503, 504)", () => {
  /** Runs `check` with fake timers, returns the result and how long it took (simulated time) */
  const withFakeTimers = async <T>(check: () => Promise<T>) => {
    vi.useFakeTimers();
    try {
      const start = Date.now();
      let finishedAt = Number.NaN;
      const promise = check().then((r) => {
        finishedAt = Date.now();
        return r;
      });
      await vi.advanceTimersByTimeAsync(60_000);
      return { result: await promise, took: finishedAt - start };
    } finally {
      vi.useRealTimers();
    }
  };

  it("fetch: a HEAD 503 falls back to GET after the backoff, a successful GET is OK", async () => {
    let failures = 1;
    const fetchMock = stubFetch(() =>
      failures-- > 0 ? new Response("busy", { status: 503 }) : new Response("ok", { status: 200 }),
    );

    const { result, took } = await withFakeTimers(() =>
      checkLinkWithFetch("https://busy.example.com/page"),
    );

    expect(result).toEqual({ ok: true, status: 200 });
    // HEAD is not retried itself, its GET fallback is (after the first backoff, with the host paused)
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["HEAD", "GET"]);
    expect(took).toBe(2000);
  });

  it("fetch: a HEAD 503 waits for its Retry-After before the GET fallback", async () => {
    let failures = 1;
    const fetchMock = stubFetch(() =>
      failures-- > 0
        ? new Response(null, { status: 503, headers: { "Retry-After": "8" } })
        : new Response("ok", { status: 200 }),
    );

    const { result, took } = await withFakeTimers(() =>
      checkLinkWithFetch("https://busy.example.com/page"),
    );

    expect(result).toEqual({ ok: true, status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(took).toBe(8000);
  });

  it("fetch: gives up on a HEAD 503 whose Retry-After is too long, without a GET", async () => {
    const fetchMock = stubFetch(
      () => new Response(null, { status: 503, headers: { "Retry-After": "120" } }),
    );

    const { result, took } = await withFakeTimers(() =>
      checkLinkWithFetch("https://busy.example.com/page"),
    );

    expect(result).toMatchObject({ ok: false, error: "could not check", status: 503 });
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["HEAD"]);
    expect(took).toBe(0);
  });

  it.each([502, 503, 504])(
    "fetch: reports a %s that persists after the retries as 'could not check', not broken",
    async (status) => {
      const fetchMock = stubFetch(() => new Response("busy", { status }));

      const { result, took } = await withFakeTimers(() =>
        checkLinkWithFetch("https://busy.example.com/page"),
      );

      expect(result).toMatchObject({ ok: false, error: "could not check", status });
      expect(!result.ok && result.errorDetail).toContain(`Server error ${status}`);
      // 1 HEAD, then (after 2s) a GET as its first retry and one more GET retry (after 2s)
      expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["HEAD", "GET", "GET"]);
      expect(took).toBe(4000);
    },
  );

  it("fetch: retries a GET (page with a hash) 503 and checks the hash", async () => {
    let failures = 2;
    const fetchMock = stubFetch(() =>
      failures-- > 0
        ? new Response("busy", { status: 503 })
        : new Response('<h2 id="x">X</h2>', { status: 200 }),
    );

    const { result, took } = await withFakeTimers(() =>
      checkLinkWithFetch("https://busy.example.com/page#x"),
    );

    expect(result).toEqual({ ok: true, status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(took).toBe(7000);
  });

  it("Playwright: retries the navigation after a 503 and checks the code line", async () => {
    playwrightState.statuses = [503];
    playwrightState.html = '<div data-line-number="167"></div>';
    const url =
      "https://github.com/WebKit/WebKit/blob/167dc5118a3f6228a19df40e673ea0a6d03b9bec/Source/WebCore/Modules/webaudio/AudioBuffer.cpp#L167";

    const { result, took } = await withFakeTimers(() =>
      withRun(async () => {
        const checked = await checkLinkWithPlaywright(url);
        expect(getRunContext()!.metrics.counters.serverErrorRetries).toBe(1);
        return checked;
      }),
    );

    expect(result).toEqual({ ok: true, status: 200 });
    expect(playwrightState.visited).toEqual([url, url]);
    expect(took).toBe(2000);
  });

  it("Playwright: respects Retry-After of a 503 navigation", async () => {
    playwrightState.statuses = [503];
    playwrightState.headers = { "retry-after": "8" };

    const { result, took } = await withFakeTimers(() =>
      checkLinkWithPlaywright("https://busy.example.com/page"),
    );

    expect(result).toEqual({ ok: true, status: 200 });
    expect(playwrightState.visited).toHaveLength(2);
    expect(took).toBe(8000);
  });

  it("Playwright: gives up right away when Retry-After is longer than the maximum delay", async () => {
    playwrightState.status = 503;
    playwrightState.headers = { "retry-after": "120" };

    const { result, took } = await withFakeTimers(() =>
      checkLinkWithPlaywright("https://busy.example.com/page"),
    );

    expect(result).toMatchObject({ ok: false, error: "could not check", status: 503 });
    expect(playwrightState.visited).toHaveLength(1);
    expect(took).toBe(0);
  });

  it("checkLinks(): a GitHub code line link still 503 in the browser fallback after the retries is 'could not check'", async () => {
    // The API can't check it (e.g. rate limited), it falls back to the browser
    checkLinkWithGithubApiMock.mockResolvedValue({ ok: false, error: "unexpected error" });
    playwrightState.status = 503;
    const href =
      "https://github.com/chromium/chromium/blob/main/components/lookalikes/core/lookalike_url_util.cc#L593";

    const { result } = await withFakeTimers(() => checkLinks({ links: [link(href)] }));

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.result).toMatchObject({
      ok: false,
      error: "could not check",
      status: 503,
    });
    // 1 navigation and 2 retries, no more
    expect(playwrightState.visited).toEqual([href, href, href]);
  });

  it("checkLinks(): a fetch 503 persisting in the browser too is 'could not check'", async () => {
    stubFetch(() => new Response(null, { status: 503 }));
    playwrightState.status = 503;
    const href = "https://busy.example.com/page";

    const { result } = await withFakeTimers(() => checkLinks({ links: [link(href)] }));

    expect(result.results[0]!.result).toMatchObject({ ok: false, error: "could not check" });
    expect(playwrightState.visited).toEqual([href, href, href]);
  });

  it("Playwright: waits for a host pause (e.g. set by a fetch server error) before navigating", async () => {
    const limiter = new HostLimiter(8);
    setHostLimiter(limiter);

    const { result, took } = await withFakeTimers(async () => {
      limiter.pause("https://busy.example.com/", 3000);
      return checkLinkWithPlaywright("https://busy.example.com/page");
    });

    expect(result).toEqual({ ok: true, status: 200 });
    expect(took).toBe(3000);
  });

  it("Playwright: a host paused while waiting for a page slot is waited for outside of the slot", async () => {
    const limiter = new HostLimiter(8);
    setHostLimiter(limiter);
    playwrightState.gotoDelayMs = 1000;

    let start = 0;
    const { result, took } = await withFakeTimers(async () => {
      start = Date.now();
      // Every page slot (PLAYWRIGHT_CONCURRENCY_LIMIT) is busy for 1s
      const busySlots = Array.from({ length: 5 }, (_, i) =>
        checkLinkWithPlaywright(`https://slow.example.com/${i}`),
      );
      // Not paused yet: both wait for a page slot
      const paused = checkLinkWithPlaywright("https://busy.example.com/page");
      const other = checkLinkWithPlaywright("https://other.example.com/page");
      // A fetch pauses the host in the meantime
      await vi.advanceTimersByTimeAsync(100);
      limiter.pause("https://busy.example.com/", 5000);
      return Promise.all([paused, other, ...busySlots]);
    });

    expect(result.every((r) => r.ok)).toBe(true);
    // Navigated once, after the pause (not right when the slot opened at 1s)
    expect(playwrightState.visited.filter((url) => url.includes("busy"))).toHaveLength(1);
    expect(playwrightState.visitedAt["https://busy.example.com/page"]! - start).toBe(5100);
    // The slot was released in the meantime: the check queued behind it did not wait for the pause
    expect(playwrightState.visitedAt["https://other.example.com/page"]! - start).toBe(1000);
    expect(took).toBe(6100);
  });

  it("Playwright: after a redirect to another host, a 503 pauses the final URL's host and the retry waits for it", async () => {
    const limiter = new HostLimiter(8);
    setHostLimiter(limiter);
    const pause = vi.spyOn(limiter, "pause");
    const waitUntilResumed = vi.spyOn(limiter, "waitUntilResumed");
    const url = "https://short.example.com/x";
    const final = "https://busy.example.com/page";
    playwrightState.finalUrlByUrl = { [url]: final };
    playwrightState.statuses = [503];

    const { result, took } = await withFakeTimers(async () => {
      const checked = checkLinkWithPlaywright(url);
      await vi.advanceTimersByTimeAsync(1);
      // The final URL's host is paused (not the navigated URL's)
      const paused = { final: limiter.isPaused(final), first: limiter.isPaused(url) };
      return { checked: await checked, paused };
    });

    expect(result.checked).toEqual({ ok: true, status: 200 });
    expect(result.paused).toEqual({ final: true, first: false });
    expect(pause).toHaveBeenCalledWith(final, 2000);
    expect(pause).toHaveBeenCalledTimes(1);
    // The retry waited for the final URL's host (and the navigated URL's)
    expect(waitUntilResumed).toHaveBeenCalledWith(final);
    expect(playwrightState.visited).toEqual([url, url]);
    expect(took).toBe(2000);
  });
});

describe("interleaveByHost() with uneven hosts", () => {
  it("keeps the round-robin order when hosts run out at different times", () => {
    const hrefs = [
      "https://a.com/1",
      "https://b.com/1",
      "https://a.com/2",
      "https://c.com/1",
      "https://a.com/3",
      "https://c.com/2",
      "https://a.com/4",
    ];
    expect(interleaveByHost(hrefs.map((href) => ({ href }))).map((item) => item.href)).toEqual([
      "https://a.com/1",
      "https://b.com/1",
      "https://c.com/1",
      "https://a.com/2",
      "https://c.com/2",
      "https://a.com/3",
      "https://a.com/4",
    ]);
  });

  it("visits every item once (many single-link hosts and one big host)", () => {
    // Generous bound to avoid CI flakiness: the old O(hosts x links) version takes far longer than 5s here
    // Scanning exhausted hosts would be 10k hosts x 100k rounds = 1e9 steps
    const items = [
      ...Array.from({ length: 100_000 }, (_, i) => ({ href: `https://big.example.com/${i}` })),
      ...Array.from({ length: 10_000 }, (_, i) => ({ href: `https://host-${i}.example.com/` })),
    ];
    const start = performance.now();
    const result = interleaveByHost(items);
    expect(performance.now() - start).toBeLessThan(5000);

    expect(result).toHaveLength(items.length);
    expect(new Set(result).size).toBe(items.length);
    // First round: one item of every host, then only the big host is left
    expect(result[0]!.href).toBe("https://big.example.com/0");
    expect(result[1]!.href).toBe("https://host-0.example.com/");
    expect(result[10_001]!.href).toBe("https://big.example.com/1");
    expect(result.at(-1)!.href).toBe("https://big.example.com/99999");
  });
});

describe("interleaveByHost()", () => {
  it("orders items round-robin by host, keeping the order within a host", () => {
    const items = [
      "https://a.com/1",
      "https://a.com/2",
      "https://a.com/3",
      "https://b.com/1",
      "https://c.com/1",
    ].map((href) => ({ href }));
    expect(interleaveByHost(items).map((item) => item.href)).toEqual([
      "https://a.com/1",
      "https://b.com/1",
      "https://c.com/1",
      "https://a.com/2",
      "https://a.com/3",
    ]);
  });
});
