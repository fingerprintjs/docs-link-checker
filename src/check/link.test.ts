import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as cheerio from "cheerio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getHostLimiter, getRunContext, withRun } from "../run";
import type { LinkCheckResult } from "../types";
import { checkLinkWithFetch as fetchCheck } from "./fetch_check";
import { checkLinks as checkLinksInRun, interleaveByHost } from "./link";
import { checkUrlsOnPageWithPlaywright as playwrightCheck } from "./playwright_check";

/**
 * Offline tests for `checkLinks` and the checkers it uses (`fetch_check.ts`, `playwright_check.ts`).
 * `fetch`, the GitHub API client and Playwright are fakes injected into the run. The fake browser evaluates selectors with cheerio, so
 * browser-specific behavior (selector syntax, hash navigation) is only covered by the integration tests.
 */

const playwrightState = {
  // URLs Playwright navigated to
  visited: [] as string[],
  // HTML the fake browser "renders"
  html: "",
  // HTML per navigated URL (hash included), falls back to `html`
  htmlByUrl: {} as Record<string, string>,
  status: 200,
  // Statuses of the next navigations (one per `goto`), then `status`
  statuses: [] as number[],
  // Headers of the navigation response (lowercase names, like Playwright)
  headers: {} as Record<string, string>,
  // Final URL of a navigation (after redirects) per navigated URL, falls back to the navigated URL
  finalUrlByUrl: {} as Record<string, string>,
  // HTML per navigated URL rendered `afterMs` after the navigation (anchors rendered late, e.g. by a timer on an
  // already loaded and quiet page), falls back to the above before that. For tests with fake timers.
  lateHtmlByUrl: {} as Record<string, { html: string; afterMs: number }>,
  // Setting the hash throws (e.g. the page navigated away)
  evaluateFails: false,
  // Setting the hash never returns (the page main thread is hung)
  evaluateHangs: false,
  // The navigation response body never ends (Playwright has no timeout for it)
  responseBodyHangs: false,
  // A missing selector times out after its whole timeout (instead of right away), for tests with fake timers
  waitForTakesTimeout: false,
};

// Fake Playwright browser: records navigations, "renders" `playwrightState.html` and evaluates selectors with cheerio
const fakeChromium = {
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
          setDefaultTimeout: () => {},
          setDefaultNavigationTimeout: () => {},
          goto: async (url: string) => {
            currentUrl = url;
            playwrightState.visited.push(url);
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
          // Only used to set the hash of the page: runs the callback against a fake `location`
          evaluate: async (fn: (hash: string) => void, hash: string) => {
            if (playwrightState.evaluateFails) {
              throw new Error("Execution context was destroyed");
            }
            if (playwrightState.evaluateHangs) {
              return new Promise<void>(() => {});
            }
            vi.stubGlobal("location", {
              set hash(value: string) {
                currentUrl = currentUrl.replace(/#.*/, "") + value;
              },
            });
            try {
              fn(hash);
            } finally {
              vi.unstubAllGlobals();
            }
          },
          locator: (selector: string) => ({
            first: () => ({
              waitFor: async (options?: { timeout?: number }) => {
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
};

const hashesHtml = readFileSync(
  join(import.meta.dirname, "..", "__fixtures__", "hashes.html"),
  "utf8",
);

type FetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>;

let fakeFetch: typeof fetch;

const stubFetch = (handler: FetchHandler) => {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init ?? {}),
  );
  fakeFetch = fetchMock;
  return fetchMock;
};

// Fake GitHub API client with the calls the tests need
const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });
const octokit = {
  issues: { get: vi.fn() },
  repos: { getContent: vi.fn() },
  git: { listMatchingRefs: vi.fn() },
  paginate: vi.fn(),
};
const getOctokit = vi.fn(() => octokit as never);

/** Runs `fn` as a run with all external dependencies faked (`stubFetch` can be called inside of `fn`) */
const run = <T>(fn: () => Promise<T>, hostConcurrency?: number) =>
  withRun(
    {
      hostConcurrency,
      deps: {
        fetch: (input, init) => fakeFetch(input, init),
        chromium: fakeChromium as never,
        octokit: getOctokit,
      },
    },
    fn,
  );

const checkLinks = (options: Parameters<typeof checkLinksInRun>[0]) =>
  run(() => checkLinksInRun(options));
const checkLinkWithFetch = (url: string) => run(() => fetchCheck(url));
const checkUrlsOnPageWithPlaywright = (urls: string[]) => run(() => playwrightCheck(urls));

const fileContent = (text: string) => ({
  data: {
    type: "file",
    sha: "abc",
    size: text.length,
    content: Buffer.from(text).toString("base64"),
  },
});

const link = (href: string, page = "https://example.com/page") => ({ href, page, text: "link" });

const checkLinkWithPlaywright = async (url: string) =>
  (await checkUrlsOnPageWithPlaywright([url])).get(url)!;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `check` in its own run (host pauses of server errors don't leak into other tests) with fake timers.
 * A missing anchor takes its whole wait, like in a real browser.
 * Returns the result and how long it took (simulated time).
 */
const withFakeTimers = async <T>(check: () => Promise<T>) => {
  vi.useFakeTimers();
  try {
    playwrightState.waitForTakesTimeout = true;
    const start = Date.now();
    let finishedAt = Number.NaN;
    const promise = run(check).then((r) => {
      finishedAt = Date.now();
      return r;
    });
    await vi.advanceTimersByTimeAsync(120_000);
    return { result: await promise, took: finishedAt - start };
  } finally {
    vi.useRealTimers();
  }
};

beforeEach(() => {
  playwrightState.visited = [];
  playwrightState.html = "<html><body></body></html>";
  playwrightState.htmlByUrl = {};
  playwrightState.finalUrlByUrl = {};
  playwrightState.lateHtmlByUrl = {};
  playwrightState.responseBodyHangs = false;
  playwrightState.evaluateFails = false;
  playwrightState.evaluateHangs = false;
  playwrightState.waitForTakesTimeout = false;
  playwrightState.status = 200;
  playwrightState.statuses = [];
  playwrightState.headers = {};
  // Some tests make it throw (no `GH_TOKEN`), restore the fake client
  getOctokit.mockReset().mockImplementation(() => octokit as never);
  octokit.issues.get.mockReset().mockResolvedValue({ data: {} });
  octokit.repos.getContent.mockReset().mockRejectedValue(notFound());
  octokit.git.listMatchingRefs.mockReset().mockResolvedValue({ data: [] });
  octokit.paginate.mockReset().mockResolvedValue([]);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
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

    const results = await checkLinks({ links });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(10);
    expect(results.every((r) => r.result.ok)).toBe(true);
    // Every link keeps its own page
    expect(new Set(results.map((r) => r.page)).size).toBe(10);
  });

  it("checks each GitHub href only once with the GitHub API", async () => {
    octokit.issues.get.mockImplementation(async () => {
      await sleep(20);
      return { data: {} };
    });
    const links = Array.from({ length: 5 }, () => link("https://github.com/owner/repo/issues/1"));

    const results = await checkLinks({ links });

    expect(octokit.issues.get).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(5);
  });
});

describe("checkLinks() Playwright escalation", () => {
  it("checks GitHub code line links with the GitHub API, without the browser", async () => {
    const href = "https://github.com/owner/repo/blob/main/a.js#L999";
    const apiResult: LinkCheckResult = {
      ok: false,
      error: "hash not found",
      status: 200,
      errorDetail: "a.js has only 3 lines",
    };
    octokit.repos.getContent.mockResolvedValue(fileContent("a\nb\nc\n"));

    const results = await checkLinks({ links: [link(href), link(href)] });

    expect(playwrightState.visited).toEqual([]);
    expect(results.map((r) => r.result)).toEqual([apiResult, apiResult]);
  });

  it("falls back to the browser for GitHub code line links the API can't check (no token, rate limited)", async () => {
    const href = "https://github.com/owner/repo/blob/main/a.js#L2";
    getOctokit.mockImplementation(() => {
      throw new Error("GH_TOKEN is not set");
    });
    playwrightState.html = '<div data-line-number="1"></div><div data-line-number="2"></div>';

    const results = await checkLinks({ links: [link(href)] });

    expect(playwrightState.visited).toEqual([href]);
    expect(results[0]!.result).toEqual({ ok: true, status: 200 });
  });

  it("reports unparsable URLs as broken without any request or Playwright re-check", async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 200 }));

    const results = await checkLinks({ links: [link("not a url")] });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(playwrightState.visited).toEqual([]);
    expect(results[0]!.result).toMatchObject({ ok: false, error: "broken link" });
  });

  it.each(["tel:+123", "javascript:void(0)", "data:text/plain,hi"])(
    "never fetches or re-checks non-http(s) URLs like %s",
    async (href) => {
      const fetchMock = stubFetch(() => new Response(null, { status: 200 }));

      const results = await checkLinks({ links: [link(href)] });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(playwrightState.visited).toEqual([]);
      expect(results[0]!.result).toMatchObject({ ok: false, error: "broken link" });
    },
  );

  it("keeps a definitive fetch failure (404) without re-checking it in the browser", async () => {
    stubFetch(() => new Response("Not found", { status: 404 }));

    const results = await checkLinks({ links: [link("https://example.com/gone")] });

    expect(playwrightState.visited).toEqual([]);
    expect(results[0]!.result).toMatchObject({ ok: false, error: "broken link", status: 404 });
  });

  it("re-checks a fetch failure that might be bot blocking (403) in the browser", async () => {
    stubFetch(() => new Response(null, { status: 403 }));
    const href = "https://example.com/blocked";

    const results = await checkLinks({ links: [link(href)] });

    expect(playwrightState.visited).toEqual([href]);
    // The Playwright result replaces the first-pass one
    expect(results[0]!.result).toEqual({ ok: true, status: 200 });
  });

  it("re-checks 'hash not found' from fetch with Playwright (client-side rendered page)", async () => {
    stubFetch(() => new Response("<html><body>Loading...</body></html>", { status: 200 }));
    playwrightState.html = '<html><body><h2 id="rendered">Rendered</h2></body></html>';
    const href = "https://example.com/spa#rendered";

    const results = await checkLinks({ links: [link(href)] });

    expect(playwrightState.visited).toEqual([href]);
    expect(results[0]!.result).toEqual({ ok: true, status: 200 });
  });

  it("checks GitHub wiki links with fetch", async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 200 }));

    await checkLinks({ links: [link("https://github.com/owner/repo/wiki/Page")] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getOctokit).not.toHaveBeenCalled();
  });

  it("checks GitHub's own pages with fetch (re-checked with Playwright if blocked), not as accounts", async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 429 }));
    const hrefs = ["https://github.com/features", "https://github.com/topics/javascript"];

    const results = await checkLinks({ links: hrefs.map((href) => link(href)) });

    expect(getOctokit).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(playwrightState.visited.toSorted()).toEqual(hrefs);
    expect(results.every((r) => r.result.ok)).toBe(true);
  });
});

describe("checkLinkWithFetch()", () => {
  it("reports a request that never answers as broken link after the timeout", async () => {
    // Node's `AbortSignal.timeout` ignores fake timers, this one uses them
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    // Only rejects when its signal aborts, like a real hanging request
    stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );

    const { result, took } = await withFakeTimers(() =>
      checkLinkWithFetch("https://example.com/slow"),
    );

    expect(result).toMatchObject({ ok: false, error: "broken link" });
    expect(took).toBe(20_000);
  });

  it("reports a failed request with its body, also for a link without a hash", async () => {
    stubFetch(() => new Response("Not found", { status: 404, statusText: "Missing" }));

    const result = await checkLinkWithFetch("https://example.com/missing");

    expect(result).toEqual({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "Missing Not found",
    });
  });

  it("accepts a page that answers HEAD with 404 and GET with 200", async () => {
    // support.google.com and chatgpt.com
    stubFetch((_url, init) =>
      init.method === "HEAD" ? new Response(null, { status: 404 }) : new Response("ok"),
    );

    expect(await checkLinkWithFetch("https://support.example.com/answer/1")).toEqual({
      ok: true,
      status: 200,
    });
  });

  it("reports a 429 with Retry-After that persists after the retries as unexpected error", async () => {
    stubFetch(() => new Response(null, { status: 429, headers: { "Retry-After": "0" } }));

    expect(await checkLinkWithFetch("https://always-limited.example.com/")).toMatchObject({
      ok: false,
      error: "unexpected error",
      status: 429,
    });
  });

  it("accepts Google Help accordion fragments without an element id", async () => {
    stubFetch(() => new Response("<html><body></body></html>", { status: 200 }));

    const result = await checkLinkWithFetch(
      "https://support.google.com/answer/10787469#zippy=%2Cdata-sharing",
    );

    expect(result).toEqual({ ok: true, status: 200, note: "Google Help accordion state" });
  });

  // Special characters are covered by hash.test.ts, these only check the wiring
  it.each(["#version-1.2.3", "#caf%C3%A9"])(
    "finds hash %s in server-rendered HTML",
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

describe("redirects", () => {
  it("fetch: reports where a redirect ended, ok or failed", async () => {
    stubFetch((url) =>
      url.endsWith("/old")
        ? new Response(null, { status: 301, headers: { Location: "/new/" } })
        : new Response(hashesHtml, { status: 200 }),
    );

    expect(await checkLinkWithFetch("https://example.com/old")).toEqual({
      ok: true,
      status: 200,
      redirectedTo: "https://example.com/new/",
    });
    expect(await checkLinkWithFetch("https://example.com/old#nothing-here")).toMatchObject({
      ok: false,
      error: "hash not found",
      redirectedTo: "https://example.com/new/",
    });
  });

  it("fetch: a redirect that only adds a trailing slash is not reported", async () => {
    stubFetch((url) =>
      url.endsWith("/docs")
        ? new Response(null, { status: 308, headers: { Location: "/docs/" } })
        : new Response("", { status: 200 }),
    );

    expect(await checkLinkWithFetch("https://example.com/docs")).toEqual({ ok: true, status: 200 });
  });

  it("playwright: reports the final URL of the navigation, without the hash", async () => {
    playwrightState.finalUrlByUrl = {
      "https://example.com/old#simple": "https://example.com/new#simple",
    };
    playwrightState.html = hashesHtml;

    expect(await checkLinkWithPlaywright("https://example.com/old#simple")).toEqual({
      ok: true,
      status: 200,
      redirectedTo: "https://example.com/new",
    });
  });

  it("playwright: a failed page reports the redirect too", async () => {
    playwrightState.finalUrlByUrl = { "https://example.com/old": "https://example.com/gone" };
    playwrightState.status = 404;

    expect(await checkLinkWithPlaywright("https://example.com/old")).toEqual({
      ok: false,
      error: "broken link",
      status: 404,
      redirectedTo: "https://example.com/gone",
    });
  });
});

describe("checkUrlsOnPageWithPlaywright() hash check", () => {
  // Special characters are covered by hash.test.ts, this only checks the wiring
  it("finds a hash with special characters", async () => {
    playwrightState.html = hashesHtml;

    const result = await checkLinkWithPlaywright("https://example.com/docs#caf%C3%A9");

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
  });

  it("waits longer for an anchor rendered late (same navigation)", async () => {
    const url = "https://docs.example.com/reference/get-event#response-ip-info-v6-address";
    // Added by a timer 4s after the navigation, on an already loaded and quiet page (e.g. Mintlify expands nested
    // response fields on hash navigation)
    playwrightState.lateHtmlByUrl = {
      [url]: { html: '<div id="response-ip-info-v6-address"></div>', afterMs: 4000 },
    };

    const { result, took } = await withFakeTimers(() => checkLinkWithPlaywright(url));

    expect(result).toEqual({ ok: true, status: 200 });
    expect(playwrightState.visited).toEqual([url]);
    // Found as soon as it appears, the rest of the budget is not waited
    expect(took).toBe(4000);
  });

  it("waits for a missing anchor until the 15s budget is used up", async () => {
    const { result, took } = await withFakeTimers(() =>
      checkLinkWithPlaywright("https://example.com/docs#never"),
    );

    expect(result).toEqual({ ok: false, status: 200, error: "hash not found" });
    expect(playwrightState.visited).toEqual(["https://example.com/docs#never"]);
    expect(took).toBe(15_000);
  });

  it("reports an anchor rendered after the budget as missing", async () => {
    const url = "https://example.com/docs#too-late";
    playwrightState.lateHtmlByUrl = {
      [url]: { html: '<div id="too-late"></div>', afterMs: 16_000 },
    };

    const { result, took } = await withFakeTimers(() => checkLinkWithPlaywright(url));

    expect(result).toEqual({ ok: false, status: 200, error: "hash not found" });
    expect(took).toBe(15_000);
  });

  it("reports a forbidden page with its body", async () => {
    playwrightState.status = 403;

    const result = await checkLinkWithPlaywright("https://example.com/docs#a");

    expect(result).toMatchObject({ ok: false, status: 403, error: "could not check" });
    expect(!result.ok && result.errorDetail).toContain("Forbidden page");
  });

  it("does not wait forever for the body of a forbidden page", async () => {
    playwrightState.status = 403;
    playwrightState.responseBodyHangs = true;

    const { result, took } = await withFakeTimers(() =>
      checkLinkWithPlaywright("https://example.com/docs#a"),
    );

    expect(result).toMatchObject({ ok: false, status: 403, error: "could not check" });
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

        const { result, took } = await withFakeTimers(() =>
          checkLinkWithPlaywright(`${file}${hash}`),
        );

        expect(result).toEqual({ ok: false, status: 200, error: "hash not found" });
        // The code view is there, so only the line itself is waited for briefly
        expect(took).toBeLessThan(5000);
      },
    );

    it("reports a line as not found when the code view never renders", async () => {
      playwrightState.html = "<div>This file is too big to show</div>";

      const { result, took } = await withFakeTimers(() => checkLinkWithPlaywright(`${file}#L2`));

      expect(result).toEqual({ ok: false, status: 200, error: "hash not found" });
      expect(took).toBe(15_000);
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

    const results = await checkLinks({ links });

    // One GET for the page, also used by the link without a hash
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

  it("reports a broken page for every hash pointing to it (one request)", async () => {
    const fetchMock = stubFetch(() => new Response("Not found", { status: 404 }));
    const links = ["#a", "#b", "#c"].map((hash) => link(`https://example.com/gone${hash}`));

    const results = await checkLinks({ links });

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

    const results = await checkLinks({ links });

    expect(playwrightState.visited).toEqual(["https://example.com/spa#one"]);
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
    getOctokit.mockImplementation(() => {
      throw new Error("GH_TOKEN is not set");
    });

    const results = await checkLinks({ links });

    expect(playwrightState.visited).toEqual([`${file}#L5`]);
    expect(results.filter((r) => r.result.ok).map((r) => r.href)).toEqual([
      `${file}#L5`,
      `${file}#L6`,
      `${file}#L5-L6`,
    ]);
    expect(results.find((r) => r.href === `${file}#L99`)?.result).toMatchObject({
      error: "hash not found",
    });
  });

  it("navigates once per page with Playwright, also for repeated hrefs", async () => {
    stubFetch(() => new Response(null, { status: 403 }));
    const links = [
      link("https://blocked.example.com/a"),
      link("https://blocked.example.com/a"),
      link("https://blocked.example.com/a#x"),
      link("https://blocked.example.com/b"),
    ];

    const results = await checkLinks({ links });

    expect(playwrightState.visited).toEqual([
      "https://blocked.example.com/a",
      "https://blocked.example.com/b",
    ]);
    expect(results).toHaveLength(4);
  });
});

describe("checkLinks() Playwright hashes of one page", () => {
  const page = "https://docs.example.com/app";

  /** Checks the hashes of `page` (client-side rendered, so they are re-checked with Playwright) with fake timers */
  const checkHashes = async (hashes: string[]) => {
    stubFetch(() => new Response("<html><body>Loading...</body></html>", { status: 200 }));
    const { result, took } = await withFakeTimers(() =>
      checkLinks({ links: hashes.map((hash) => link(`${page}${hash}`)) }),
    );
    const byHash = new Map(result.map((r) => [r.href.slice(page.length), r.result]));
    return { byHash, took };
  };

  it("finds late anchors of every hash with one navigation and one shared wait", async () => {
    // Both anchors are added by a timer 4s after the navigation (e.g. expanded nested fields)
    playwrightState.lateHtmlByUrl = {
      [`${page}#a`]: { html: '<div id="a"></div><div id="b"></div>', afterMs: 4000 },
    };

    const { byHash, took } = await checkHashes(["#a", "#b"]);

    expect(byHash.get("#a")).toEqual({ ok: true, status: 200 });
    expect(byHash.get("#b")).toEqual({ ok: true, status: 200 });
    expect(playwrightState.visited).toEqual([`${page}#a`]);
    expect(took).toBe(4000);
  });

  it("finds a hash that is rendered only after the hash is set in the open page (SPA tabs)", async () => {
    playwrightState.htmlByUrl = {
      [`${page}#tab-a`]: '<div id="tab-a"></div>',
      [`${page}#tab-b`]: '<div id="tab-b"></div>',
    };

    const { byHash } = await checkHashes(["#tab-a", "#tab-b", "#missing"]);

    expect(byHash.get("#tab-a")).toEqual({ ok: true, status: 200 });
    expect(byHash.get("#tab-b")).toEqual({ ok: true, status: 200 });
    expect(byHash.get("#missing")).toEqual({ ok: false, status: 200, error: "hash not found" });
    // No navigation per hash
    expect(playwrightState.visited).toEqual([`${page}#tab-a`]);
  });

  it("keeps 'hash not found' for a hash whose in-page retry fails, other results stay", async () => {
    playwrightState.evaluateFails = true;
    playwrightState.htmlByUrl = { [`${page}#a`]: '<div id="a"></div>' };

    const { byHash } = await checkHashes(["#a", "#missing"]);

    expect(byHash.get("#a")).toEqual({ ok: true, status: 200 });
    expect(byHash.get("#missing")).toEqual({ ok: false, status: 200, error: "hash not found" });
  });

  it("stops the in-page retries of a page that hangs, other results stay", async () => {
    playwrightState.evaluateHangs = true;
    playwrightState.htmlByUrl = { [`${page}#a`]: '<div id="a"></div>' };

    const { byHash, took } = await checkHashes(["#a", "#missing", "#missing2"]);

    expect(byHash.get("#a")).toEqual({ ok: true, status: 200 });
    expect(byHash.get("#missing")).toEqual({ ok: false, status: 200, error: "hash not found" });
    expect(byHash.get("#missing2")).toEqual({ ok: false, status: 200, error: "hash not found" });
    // 15s shared wait, then one 3s timeout (the next hash is not tried)
    expect(took).toBe(15_000 + 3000);
  });

  it("spends the 15s budget once per page, not once per missing hash", async () => {
    const { byHash, took } = await checkHashes(["#a", "#b", "#c", "#d"]);

    for (const hash of ["#a", "#b", "#c", "#d"]) {
      expect(byHash.get(hash)).toEqual({ ok: false, status: 200, error: "hash not found" });
    }
    // 15s shared wait, then 3s for each of the 3 hashes set in the page
    expect(took).toBe(15_000 + 3 * 3000);
  });
});

describe("server errors (502, 503, 504)", () => {
  it("fetch: reports a 503 that persists after the retries as 'could not check', not broken", async () => {
    stubFetch(() => new Response("busy", { status: 503 }));

    const { result } = await withFakeTimers(() =>
      checkLinkWithFetch("https://busy.example.com/page"),
    );

    expect(result).toMatchObject({ ok: false, error: "could not check", status: 503 });
    expect(!result.ok && result.errorDetail).toContain("Server error 503");
  });

  it("fetch: checks the hash of a page that answers 503 first", async () => {
    let failures = 2;
    stubFetch(() =>
      failures-- > 0
        ? new Response("busy", { status: 503 })
        : new Response('<h2 id="x">X</h2>', { status: 200 }),
    );

    const { result } = await withFakeTimers(() =>
      checkLinkWithFetch("https://busy.example.com/page#x"),
    );

    expect(result).toEqual({ ok: true, status: 200 });
  });

  it("Playwright: retries the navigation after a 503 and checks the code line", async () => {
    playwrightState.statuses = [503];
    playwrightState.html = '<div data-line-number="167"></div>';
    const url = "https://github.com/owner/repo/blob/main/a.js#L167";

    const { result, took } = await withFakeTimers(async () => checkLinkWithPlaywright(url));

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

  it("checkLinks(): a fetch 503 persisting in the browser too is 'could not check'", async () => {
    stubFetch(() => new Response(null, { status: 503 }));
    playwrightState.status = 503;
    const href = "https://busy.example.com/page";

    const { result } = await withFakeTimers(() => checkLinks({ links: [link(href)] }));

    expect(result[0]!.result).toMatchObject({ ok: false, error: "could not check", status: 503 });
    // 1 navigation and 2 retries, no more
    expect(playwrightState.visited).toEqual([href, href, href]);
  });

  it("Playwright: waits for a host pause (e.g. set by a fetch server error) before navigating", async () => {
    const { result, took } = await withFakeTimers(async () => {
      getHostLimiter().pause("https://busy.example.com/", 3000);
      return checkLinkWithPlaywright("https://busy.example.com/page");
    });

    expect(result).toEqual({ ok: true, status: 200 });
    expect(took).toBe(3000);
  });

  it("Playwright: after a redirect to another host, a 503 pauses the final URL's host and the retry waits for it", async () => {
    const url = "https://short.example.com/x";
    const final = "https://busy.example.com/page";
    playwrightState.finalUrlByUrl = { [url]: final };
    playwrightState.statuses = [503];

    const { result, took } = await withFakeTimers(async () => {
      const limiter = getHostLimiter();
      const checked = checkLinkWithPlaywright(url);
      await vi.advanceTimersByTimeAsync(1);
      // How long a request to each host waits now: only the final URL's host is paused (not the navigated URL's)
      const waitFor = async (target: string) => {
        const waitStart = Date.now();
        await limiter.waitUntilResumed(target);
        return Date.now() - waitStart;
      };
      const firstWait = await waitFor(url);
      const finalWait = waitFor(final);
      return { checked: await checked, firstWait, finalWait: await finalWait };
    });

    expect(result.checked).toEqual({ ok: true, status: 200, redirectedTo: final });
    expect(result.firstWait).toBe(0);
    expect(result.finalWait).toBeGreaterThan(1900);
    expect(playwrightState.visited).toEqual([url, url]);
    expect(took).toBe(2000);
  });
});

describe("checkLinks() per-host limit", () => {
  it("never sends more than the per-host limit of concurrent requests to a host", async () => {
    const active: Record<string, number> = {};
    const max: Record<string, number> = {};
    stubFetch(async (url) => {
      const host = new URL(url).hostname;
      active[host] = (active[host] ?? 0) + 1;
      max[host] = Math.max(max[host] ?? 0, active[host]);
      await sleep(5);
      active[host]--;
      return new Response(null, { status: 200 });
    });
    const links = [
      ...Array.from({ length: 30 }, (_, i) => `https://busy.example.com/page-${i}`),
      ...Array.from({ length: 5 }, (_, i) => `https://quiet.example.com/page-${i}`),
    ].map((href) => link(href));

    const results = await run(() => checkLinksInRun({ links }), 3);

    expect(results).toHaveLength(35);
    expect(results.every((r) => r.result.ok)).toBe(true);
    expect(max["busy.example.com"]).toBe(3);
    expect(max["quiet.example.com"]).toBe(3);
  });
});

describe("checkLinks() metrics", () => {
  const countersOf = (links: ReturnType<typeof link>[]) =>
    run(async () => {
      await checkLinksInRun({ links });
      return getRunContext()!.metrics.counters;
    });

  it("counts total links, unique URLs, unique pages and page fetches", async () => {
    stubFetch(() => new Response('<a id="a"></a><a id="b"></a>', { status: 200 }));
    const hrefs = [
      "https://example.com/p#a",
      "https://example.com/p#b",
      "https://example.com/p#a",
      "https://example.com/q",
    ];

    const counters = await countersOf(hrefs.map((href) => link(href)));

    expect(counters).toMatchObject({
      totalLinks: 4,
      uniqueUrls: 3,
      uniquePages: 2,
      uniquePagesFetched: 2,
      httpRequests: 2,
    });
  });

  it("counts every HTTP request (redirect hops) separately from unique pages", async () => {
    stubFetch((url) =>
      url === "https://example.com/old"
        ? new Response(null, { status: 301, headers: { Location: "/new" } })
        : new Response("ok", { status: 200 }),
    );

    const counters = await countersOf([link("https://example.com/old")]);

    // GET /old (301), GET /new (200)
    expect(counters).toMatchObject({ uniquePagesFetched: 1, httpRequests: 2 });
  });
});

describe("interleaveByHost()", () => {
  it("orders items round-robin by host, keeping the order within a host", () => {
    const hrefs = [
      "https://a.com/1",
      "https://a.com/2",
      "https://a.com/3",
      "https://b.com/1",
      "https://c.com/1",
    ];
    expect(interleaveByHost(hrefs.map((href) => ({ href }))).map((item) => item.href)).toEqual([
      "https://a.com/1",
      "https://b.com/1",
      "https://c.com/1",
      "https://a.com/2",
      "https://a.com/3",
    ]);
  });

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
    // Must be linear in the number of items: scanning exhausted hosts in every round would be 1e9 steps here
    // and does not finish within the test timeout
    const items = [
      ...Array.from({ length: 100_000 }, (_, i) => ({ href: `https://big.example.com/${i}` })),
      ...Array.from({ length: 10_000 }, (_, i) => ({ href: `https://host-${i}.example.com/` })),
    ];

    const result = interleaveByHost(items);

    expect(result).toHaveLength(items.length);
    expect(new Set(result).size).toBe(items.length);
    // First round: one item of every host, then only the big host is left
    expect(result[0]!.href).toBe("https://big.example.com/0");
    expect(result[1]!.href).toBe("https://host-0.example.com/");
    expect(result[10_001]!.href).toBe("https://big.example.com/1");
    expect(result.at(-1)!.href).toBe("https://big.example.com/99999");
  });
});
