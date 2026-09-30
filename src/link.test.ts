import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import * as cheerio from "cheerio";
import { LinkCheckResult } from "./types";

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
    status: 200,
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
        newPage: async () => ({
          isClosed: () => false,
          goto: async (url: string) => {
            playwrightState.visited.push(url);
            return {
              status: () => playwrightState.status,
              statusText: () => "",
              text: async () => "",
            };
          },
          locator: (selector: string) => ({
            first: () => ({
              waitFor: async () => {
                playwrightState.selectors.push(selector);
                // Throws for invalid selectors, like Playwright would
                if (cheerio.load(playwrightState.html)(selector).length === 0) {
                  const error = new Error("Timeout");
                  error.name = "TimeoutError";
                  throw error;
                }
              },
            }),
          }),
        }),
      }),
    }),
  },
}));

import {
  checkLinks,
  checkLinkWithFetch,
  checkLinkWithPlaywright,
  interleaveByHost,
  shouldRecheckWithPlaywright,
} from "./link";

const hashesHtml = readFileSync(join(__dirname, "__fixtures__", "hashes.html"), "utf8");

type FetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>;

const stubFetch = (handler: FetchHandler) => {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init ?? {})
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const link = (href: string, page = "https://example.com/page") => ({ href, page, text: "link" });

beforeEach(() => {
  playwrightState.visited = [];
  playwrightState.selectors = [];
  playwrightState.html = "<html><body></body></html>";
  playwrightState.status = 200;
  checkLinkWithGithubApiMock.mockReset();
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
    const links = Array.from({ length: 10 }, (_, i) => link("https://example.com/same", `https://example.com/p${i}`));

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
    ["404 from the API", { ok: false, error: "broken link", status: 404, errorDetail: "Issue not found" }, false],
    ["hash not found from the API", { ok: false, error: "hash not found", status: 200 }, false],
    ["unexpected API error", { ok: false, error: "unexpected error", status: 400 }, true],
  ];

  it.each(githubApiCases)("GitHub API result: %s -> re-checked with Playwright: %s", async (_name, apiResult, escalate) => {
    checkLinkWithGithubApiMock.mockResolvedValue(apiResult);
    const href = "https://github.com/owner/repo/issues/999";

    const { results } = await checkLinks({ links: [link(href)] });

    expect(playwrightState.visited).toEqual(escalate ? [href] : []);
    expect(results).toHaveLength(1);
    if (!escalate) {
      // The definitive API result is reported as-is
      expect(results[0].result).toEqual(apiResult);
    }
  });

  it("checks GitHub code line links only in the Playwright pass (respects its concurrency limit)", async () => {
    const href = "https://github.com/owner/repo/blob/main/a.js#L999";

    await checkLinks({ links: [link(href), link(href)] });

    expect(checkLinkWithGithubApiMock).not.toHaveBeenCalled();
    expect(playwrightState.visited).toEqual([href]);
  });

  it("reports unparsable URLs as broken without any request or Playwright re-check", async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 200 }));

    const { results } = await checkLinks({ links: [link("not a url")] });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(playwrightState.visited).toEqual([]);
    expect(results[0].result).toMatchObject({ ok: false, error: "broken link" });
  });

  it.each(["tel:+123", "javascript:void(0)", "data:text/plain,hi"])(
    "never fetches or re-checks non-http(s) URLs like %s",
    async (href) => {
      const fetchMock = stubFetch(() => new Response(null, { status: 200 }));

      const { results } = await checkLinks({ links: [link(href)] });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(playwrightState.visited).toEqual([]);
      expect(results[0].result).toMatchObject({ ok: false, error: "broken link" });
    }
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

  it.each(fetchCases)("fetch result: %s -> re-checked with Playwright: %s", async (_name, handler, escalate) => {
    stubFetch(handler);
    const href = "https://example.com/some/page";

    const { results } = await checkLinks({ links: [link(href)] });

    expect(playwrightState.visited).toEqual(escalate ? [href] : []);
    expect(results).toHaveLength(1);
  });

  it("re-checks 'hash not found' from fetch with Playwright (client-side rendered page)", async () => {
    stubFetch(() => new Response("<html><body>Loading...</body></html>", { status: 200 }));
    playwrightState.html = '<html><body><h2 id="rendered">Rendered</h2></body></html>';
    const href = "https://example.com/spa#rendered";

    const { results } = await checkLinks({ links: [link(href)] });

    expect(playwrightState.visited).toEqual([href]);
    expect(results[0].result).toEqual({ ok: true, status: 200 });
  });

  it("checks GitHub wiki links with fetch", async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 200 }));

    await checkLinks({ links: [link("https://github.com/owner/repo/wiki/Page")] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(checkLinkWithGithubApiMock).not.toHaveBeenCalled();
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
    expect(result.ok === false && result.errorDetail).toContain("Invalid URL");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sets a request timeout", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = stubFetch(() => new Response(null, { status: 200 }));

    await checkLinkWithFetch("https://example.com");

    expect(timeoutSpy).toHaveBeenCalledWith(20000);
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports a timed out request as broken link", async () => {
    stubFetch(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });

    const result = await checkLinkWithFetch("https://example.com/slow");

    expect(result).toMatchObject({ ok: false, error: "broken link" });
    expect(result.ok === false && result.errorDetail).toContain("TimeoutError");
  });

  it.each([405, 403, 501])("retries once with GET when HEAD returns %s", async (status) => {
    const fetchMock = stubFetch((_url, init) =>
      init.method === "HEAD" ? new Response(null, { status }) : new Response("ok", { status: 200 })
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

  it("does not retry with GET on 404", async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 404 }));

    const result = await checkLinkWithFetch("https://example.com/missing");

    expect(result).toMatchObject({ ok: false, error: "broken link", status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it.each(existingHashes)("finds hash %s with special characters in server-rendered HTML", async (hash) => {
    stubFetch(() => new Response(hashesHtml, { status: 200 }));

    const result = await checkLinkWithFetch(`https://example.com/docs${hash}`);

    expect(result).toEqual({ ok: true, status: 200 });
  });

  it("reports missing hashes as 'hash not found' (not 'broken link')", async () => {
    stubFetch(() => new Response(hashesHtml, { status: 200 }));

    const result = await checkLinkWithFetch("https://example.com/docs#version-9.9.9");

    expect(result).toEqual({ ok: false, status: 200, error: "hash not found" });
  });
});

describe("checkLinkWithPlaywright() hash check", () => {
  it.each(["#version-1.2.3", "#1-create-an-account", "#say-%22hi%22", "#caf%C3%A9", "#legacy-anchor"])(
    "builds a valid selector for %s",
    async (hash) => {
      playwrightState.html = hashesHtml;

      const result = await checkLinkWithPlaywright(`https://example.com/docs${hash}`);

      expect(result).toEqual({ ok: true, status: 200 });
    }
  );

  it("reports missing hashes as 'hash not found'", async () => {
    playwrightState.html = hashesHtml;

    const result = await checkLinkWithPlaywright("https://example.com/docs#it's-%22missing%22");

    expect(result).toEqual({ ok: false, status: 200, error: "hash not found" });
  });
});

describe("checkLinks() grouping by page (URL without hash)", () => {
  it("fetches a page once for all its hashes and checks every hash against the same HTML", async () => {
    const fetchMock = stubFetch(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(hashesHtml, { status: 200 });
    });
    const hrefs = ["#version-1.2.3", "#legacy-anchor", "#caf%C3%A9", "#does-not-exist", ""].map(
      (hash) => `https://example.com/docs${hash}`
    );
    // Every href appears twice (on different source pages)
    const links = [...hrefs, ...hrefs].map((href, i) => link(href, `https://example.com/source-${i}`));

    const { results, errors } = await checkLinks({ links });

    expect(errors).toHaveLength(0);
    // One GET for the page, also used by the link without a hash (no extra HEAD request)
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET");
    expect(results).toHaveLength(10);
    const resultByHref = new Map(results.map((r) => [r.href, r.result]));
    expect(resultByHref.get("https://example.com/docs#version-1.2.3")).toEqual({ ok: true, status: 200 });
    expect(resultByHref.get("https://example.com/docs#caf%C3%A9")).toEqual({ ok: true, status: 200 });
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
      Array(3).fill(expect.objectContaining({ ok: false, error: "broken link", status: 404 }))
    );
  });

  it("navigates once with Playwright for all hashes of a page and checks each hash in the same DOM", async () => {
    // Client-side rendered page: the server HTML has no anchors
    stubFetch(() => new Response("<html><body>Loading...</body></html>", { status: 200 }));
    playwrightState.html = '<html><body><h2 id="one">One</h2><a name="two"></a></body></html>';
    const links = ["#one", "#two", "#three"].map((hash) => link(`https://example.com/spa${hash}`));

    const { results } = await checkLinks({ links });

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

  it("checks GitHub code line links to the same file with one navigation", async () => {
    playwrightState.html = '<html><body><div data-line-number="5"></div><div data-line-number="6"></div></body></html>';
    const file = "https://github.com/owner/repo/blob/main/a.js";
    const links = ["#L5", "#L6", "#L5-L6", "#L99"].map((hash) => link(`${file}${hash}`));

    const { results } = await checkLinks({ links });

    expect(checkLinkWithGithubApiMock).not.toHaveBeenCalled();
    expect(playwrightState.visited).toEqual([`${file}#L5`]);
    expect(results.filter((r) => r.result.ok).map((r) => r.href)).toEqual([
      `${file}#L5`,
      `${file}#L6`,
      `${file}#L5-L6`,
    ]);
    expect(results.find((r) => r.href === `${file}#L99`)?.result).toMatchObject({ error: "hash not found" });
  });

  it("navigates once per page with Playwright", async () => {
    stubFetch(() => new Response(null, { status: 403 }));
    const links = [
      link("https://blocked.example.com/a"),
      link("https://blocked.example.com/a#x"),
      link("https://blocked.example.com/b"),
    ];

    const { results } = await checkLinks({ links });

    expect(playwrightState.visited).toHaveLength(2);
    expect(results).toHaveLength(3);
  });
});

describe("interleaveByHost()", () => {
  it("orders items round-robin by host, keeping the order within a host", () => {
    const items = ["https://a.com/1", "https://a.com/2", "https://a.com/3", "https://b.com/1", "https://c.com/1"].map(
      (href) => ({ href })
    );
    expect(interleaveByHost(items).map((item) => item.href)).toEqual([
      "https://a.com/1",
      "https://b.com/1",
      "https://c.com/1",
      "https://a.com/2",
      "https://a.com/3",
    ]);
  });
});
