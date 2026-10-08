import { readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Clock, Effect, Layer, Logger, LogLevel } from "effect";
import { describe, expect } from "vitest";
import { GitHubApiError } from "./errors";
import type { GitHubApi } from "./github/github_client";
import { checkLinks, interleaveByHost } from "./link";
import { Metrics } from "./metrics";
import { runWithClock } from "./test/clock";
import { fakeChromium, makeFakeChromiumState } from "./test/fake_chromium";
import { type FetchHandler, fakeFetch } from "./test/fake_fetch";
import { fakeGitHub } from "./test/fake_github";
import { testRunLayer } from "./test/layers";

/**
 * Offline tests for `checkLinks`: real `HostLimiter`, `Metrics`, `Browser`, GitHub checks and page checks over a fake
 * `fetch`, `GitHub` and Chromium. Details of the Playwright re-check are covered by `playwright_check.test.ts`.
 */

const hashesHtml = readFileSync(join(import.meta.dirname, "__fixtures__", "hashes.html"), "utf8");

const link = (href: string, page = "https://example.com/page") => ({ href, page, text: "link" });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const notFound = () => Effect.fail(new GitHubApiError({ status: 404, cause: new Error("404") }));

const setup = (
  handler: FetchHandler,
  options: { readonly hostConcurrency?: number; readonly github?: Partial<GitHubApi> } = {},
) => {
  const fake = fakeFetch(handler);
  const github = fakeGitHub(options.github ?? {});
  const browser = makeFakeChromiumState();
  return {
    calls: fake.calls,
    githubCalls: github.calls,
    /** What the fake browser shows and did (`visited`: URLs navigated to, so the Playwright re-check ran) */
    browser,
    provide: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provide(
          testRunLayer({
            fetch: fake.layer,
            github: github.layer,
            chromium: fakeChromium(browser),
            hostConcurrency: options.hostConcurrency,
          }).pipe(Layer.provideMerge(Logger.minimumLogLevel(LogLevel.None))),
        ),
      ),
  };
};

describe("checkLinks() deduplication", () => {
  it.effect("checks each href only once, even when concurrent tasks check the same href", () => {
    const { provide, calls } = setup(async () => {
      await sleep(20);
      return new Response(null, { status: 200 });
    });
    const links = Array.from({ length: 10 }, (_, i) =>
      link("https://example.com/same", `https://example.com/p${i}`),
    );
    return provide(
      Effect.gen(function* () {
        const results = yield* checkLinks({ links });

        expect(calls).toHaveLength(1);
        expect(results).toHaveLength(10);
        expect(results.every((r) => r.result.ok)).toBe(true);
        // Every link keeps its own page
        expect(new Set(results.map((r) => r.page)).size).toBe(10);
      }),
    );
  });

  it.effect("checks each GitHub href only once with the GitHub API", () => {
    const { provide, githubCalls } = setup(() => new Response(null, { status: 200 }), {
      github: { getIssue: () => Effect.yieldNow() },
    });
    const links = Array.from({ length: 5 }, () => link("https://github.com/owner/repo/issues/1"));
    return provide(
      Effect.gen(function* () {
        const results = yield* checkLinks({ links });

        expect(githubCalls).toEqual(['getIssue("owner", "repo", 1)']);
        expect(results).toHaveLength(5);
        expect(results.every((r) => r.result.ok)).toBe(true);
      }),
    );
  });
});

describe("checkLinks() Playwright escalation", () => {
  const issue = "https://github.com/owner/repo/issues/999";
  const apiCases: Array<[string, Partial<GitHubApi>, boolean]> = [
    ["404", { getIssue: notFound }, false],
    [
      "unexpected error",
      { getIssue: () => Effect.fail(new GitHubApiError({ status: 500, cause: "boom" })) },
      true,
    ],
  ];

  it.effect.each(apiCases)(
    "GitHub API result: %s -> re-checked with Playwright: %s",
    ([, github, escalate]) => {
      const { provide, browser } = setup(() => new Response(null, { status: 200 }), { github });
      return provide(
        Effect.gen(function* () {
          const results = yield* checkLinks({ links: [link(issue)] });

          expect(browser.visited).toEqual(escalate ? [issue] : []);
          // A definitive API result is reported as is, the browser result is the fake page (no hash to look for)
          expect(results[0]?.result).toMatchObject(
            escalate ? { ok: true, status: 200 } : { ok: false, error: "broken link", status: 404 },
          );
        }),
      );
    },
  );

  const codeFile = {
    getRepo: () => Effect.succeed({ default_branch: "main" }),
    getContent: () => Effect.succeed({ content: "", sha: "sha" }),
    getFileText: () =>
      Effect.succeed({
        text: "one\ntwo\nthree",
        binary: false,
        getAnchors: () => new Set<string>(),
      }),
  } satisfies Partial<GitHubApi>;

  it.effect("checks GitHub code line links with the GitHub API, without the browser", () => {
    const href = "https://github.com/owner/repo/blob/main/a.js#L999";
    const { provide, browser } = setup(() => new Response(null, { status: 200 }), {
      github: codeFile,
    });
    return provide(
      Effect.gen(function* () {
        const results = yield* checkLinks({ links: [link(href), link(href)] });

        expect(browser.visited).toEqual([]);
        const hashNotFound = {
          ok: false,
          error: "hash not found",
          status: 200,
          errorDetail: "a.js has only 3 lines",
        };
        expect(results.map((r) => r.result)).toEqual([hashNotFound, hashNotFound]);
      }),
    );
  });

  it.effect(
    "falls back to the browser for GitHub code line links the API can't check (no token, rate limited)",
    () => {
      const href = "https://github.com/owner/repo/blob/main/a.js#L2";
      const { provide, browser } = setup(() => new Response(null, { status: 200 }), {
        github: { getContent: () => Effect.fail(new GitHubApiError({ status: 403, cause: "x" })) },
      });
      browser.html = '<div data-line-number="1"></div><div data-line-number="2"></div>';
      return provide(
        Effect.gen(function* () {
          const results = yield* checkLinks({ links: [link(href)] });

          expect(browser.visited).toEqual([href]);
          expect(results[0]?.result).toEqual({ ok: true, status: 200 });
        }),
      );
    },
  );

  it.effect("reports unparsable URLs as broken without any request or Playwright re-check", () => {
    const { provide, calls } = setup(() => new Response(null, { status: 200 }));
    return provide(
      Effect.gen(function* () {
        const results = yield* checkLinks({ links: [link("not a url")] });

        expect(calls).toEqual([]);
        expect(results[0]?.result).toMatchObject({ ok: false, error: "broken link" });
      }),
    );
  });

  it.effect.each(["tel:+123", "javascript:void(0)", "data:text/plain,hi"])(
    "never fetches or re-checks non-http(s) URLs like %s",
    (href) => {
      const { provide, calls } = setup(() => new Response(null, { status: 200 }));
      return provide(
        Effect.gen(function* () {
          const results = yield* checkLinks({ links: [link(href)] });

          expect(calls).toEqual([]);
          expect(results[0]?.result).toMatchObject({ ok: false, error: "broken link" });
        }),
      );
    },
  );

  const fetchCases: Array<[string, boolean, FetchHandler]> = [
    ["404", false, () => new Response("Not found", { status: 404 })],
    ["410", false, () => new Response("Gone", { status: 410 })],
    ["403 (bot blocking)", true, () => new Response(null, { status: 403 })],
    ["401", true, () => new Response(null, { status: 401 })],
    ["429 without Retry-After", true, () => new Response(null, { status: 429 })],
    ["503", true, () => new Response(null, { status: 503 })],
    [
      "network error",
      true,
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ];

  it.effect.each(fetchCases)(
    "fetch result: %s -> re-checked with Playwright: %s",
    ([, escalate, handler]) => {
      const { provide, browser } = setup(handler);
      return provide(
        Effect.gen(function* () {
          // The 503 case waits for its retries
          const results = yield* runWithClock(
            checkLinks({ links: [link("https://example.com/some/page")] }),
            "10 seconds",
          );

          expect(results).toHaveLength(1);
          expect(browser.visited.length > 0).toBe(escalate);
        }),
      );
    },
  );

  it.effect(
    "re-checks 'hash not found' from fetch with Playwright (client-side rendered page)",
    () => {
      const { provide, browser } = setup(
        () => new Response("<html><body>Loading...</body></html>", { status: 200 }),
      );
      browser.html = '<html><body><h2 id="rendered"></h2></body></html>';
      return provide(
        Effect.gen(function* () {
          const results = yield* checkLinks({ links: [link("https://example.com/spa#rendered")] });

          expect(browser.visited).toEqual(["https://example.com/spa#rendered"]);
          expect(results[0]?.result).toEqual({ ok: true, status: 200 });
        }),
      );
    },
  );

  it.effect("checks GitHub wiki links with fetch", () => {
    const { provide, calls, githubCalls } = setup(() => new Response(null, { status: 200 }));
    return provide(
      Effect.gen(function* () {
        yield* checkLinks({ links: [link("https://github.com/owner/repo/wiki/Page")] });

        expect(calls).toHaveLength(1);
        expect(githubCalls).toEqual([]);
      }),
    );
  });

  it.effect(
    "checks GitHub's own pages with fetch (re-checked with Playwright if blocked), not as accounts",
    () => {
      const { provide, calls, githubCalls, browser } = setup(
        () => new Response(null, { status: 429 }),
      );
      const hrefs = ["https://github.com/features", "https://github.com/topics/javascript"];
      return provide(
        Effect.gen(function* () {
          const results = yield* checkLinks({ links: hrefs.map((href) => link(href)) });

          expect(githubCalls).toEqual([]);
          expect(calls).toHaveLength(2);
          expect(browser.visited).toEqual(hrefs);
          expect(results.every((r) => r.result.ok)).toBe(true);
        }),
      );
    },
  );

  it.effect("a link failing with fetch passes when the Playwright re-check passes", () => {
    const { provide, browser } = setup(() => new Response("Forbidden", { status: 403 }));
    const href = "https://example.com/blocked";
    return provide(
      Effect.gen(function* () {
        const results = yield* checkLinks({ links: [link(href)] });

        expect(browser.visited).toEqual([href]);
        expect(results[0]?.result).toEqual({ ok: true, status: 200 });
      }),
    );
  });
});

describe("checkLinks() grouping by page (URL without hash)", () => {
  it.effect(
    "fetches a page once for all its hashes and checks every hash against the same HTML",
    () => {
      const { provide, calls } = setup(async () => {
        await sleep(10);
        return new Response(hashesHtml, { status: 200 });
      });
      const hrefs = ["#version-1.2.3", "#legacy-anchor", "#caf%C3%A9", ""].map(
        (hash) => `https://example.com/docs${hash}`,
      );
      // Every href appears twice (on different source pages)
      const links = [...hrefs, ...hrefs].map((href, i) =>
        link(href, `https://example.com/source-${i}`),
      );
      return provide(
        Effect.gen(function* () {
          const results = yield* checkLinks({ links });

          // One GET for the page, also used by the link without a hash
          expect(calls).toHaveLength(1);
          expect(calls[0]?.init.method).toBe("GET");
          expect(results).toHaveLength(8);
          expect(results.map((r) => r.result)).toEqual(
            Array.from({ length: 8 }, () => ({ ok: true, status: 200 })),
          );
          // Every link keeps its own source page
          expect(new Set(results.map((r) => r.page)).size).toBe(8);
        }),
      );
    },
  );

  it.effect("reports a broken page for every hash pointing to it (one request)", () => {
    const { provide, calls } = setup(() => new Response("Not found", { status: 404 }));
    const links = ["#a", "#b", "#c"].map((hash) => link(`https://example.com/gone${hash}`));
    return provide(
      Effect.gen(function* () {
        const results = yield* checkLinks({ links });

        expect(calls).toHaveLength(1);
        expect(results.map((r) => r.result)).toEqual(
          Array.from({ length: 3 }, () =>
            expect.objectContaining({ ok: false, error: "broken link", status: 404 }),
          ),
        );
      }),
    );
  });

  it.effect(
    "navigates once with Playwright for all hashes of a page and checks each hash in the same DOM",
    () => {
      // Client-side rendered page: the server HTML has no anchors
      const { provide, browser } = setup(
        () => new Response("<html><body>Loading...</body></html>", { status: 200 }),
      );
      browser.html = '<html><body><h2 id="one">One</h2><a name="two"></a></body></html>';
      const links = ["#one", "#two", "#three"].map((hash) =>
        link(`https://example.com/spa${hash}`),
      );
      return provide(
        Effect.gen(function* () {
          const results = yield* checkLinks({ links });

          expect(browser.visited).toEqual(["https://example.com/spa#one"]);
          expect(results.map((r) => [new URL(r.href).hash, r.result])).toEqual([
            ["#one", { ok: true, status: 200 }],
            ["#two", { ok: true, status: 200 }],
            ["#three", { ok: false, status: 200, error: "hash not found" }],
          ]);
        }),
      );
    },
  );

  it.effect(
    "checks GitHub code line links to the same file with one navigation (browser fallback)",
    () => {
      // The API can't check them (here: rate limited), they fall back to the browser
      const { provide, browser } = setup(() => new Response(null, { status: 200 }), {
        github: { getContent: () => Effect.fail(new GitHubApiError({ status: 403, cause: "x" })) },
      });
      browser.html =
        '<html><body><div data-line-number="5"></div><div data-line-number="6"></div></body></html>';
      const file = "https://github.com/owner/repo/blob/main/a.js";
      const links = ["#L5", "#L6", "#L5-L6", "#L99"].map((hash) => link(`${file}${hash}`));
      return provide(
        Effect.gen(function* () {
          const results = yield* checkLinks({ links });

          expect(browser.visited).toEqual([`${file}#L5`]);
          expect(results.filter((r) => r.result.ok).map((r) => r.href)).toEqual([
            `${file}#L5`,
            `${file}#L6`,
            `${file}#L5-L6`,
          ]);
          expect(results.find((r) => r.href === `${file}#L99`)?.result).toMatchObject({
            error: "hash not found",
          });
        }),
      );
    },
  );

  it.effect("navigates once per page with Playwright, also for repeated hrefs", () => {
    const { provide, browser } = setup(() => new Response(null, { status: 403 }));
    const links = [
      link("https://blocked.example.com/a"),
      link("https://blocked.example.com/a"),
      link("https://blocked.example.com/a#x"),
      link("https://blocked.example.com/b"),
    ];
    return provide(
      Effect.gen(function* () {
        const results = yield* checkLinks({ links });

        expect(browser.visited).toEqual([
          "https://blocked.example.com/a",
          "https://blocked.example.com/b",
        ]);
        expect(results).toHaveLength(4);
      }),
    );
  });

  it.effect("finds late anchors of every hash with one navigation and one shared wait", () => {
    const page = "https://docs.example.com/app";
    const { provide, browser } = setup(
      () => new Response("<html><body>Loading...</body></html>", { status: 200 }),
    );
    // Both anchors are added by a timer 4s after the navigation (e.g. expanded nested fields)
    browser.waitForTakesTimeout = true;
    browser.lateHtmlByUrl = {
      [`${page}#a`]: { html: '<div id="a"></div><div id="b"></div>', afterMs: 4000 },
    };
    return provide(
      Effect.gen(function* () {
        const start = yield* Clock.currentTimeMillis;
        const results = yield* runWithClock(
          checkLinks({ links: ["#a", "#b"].map((hash) => link(`${page}${hash}`)) }),
          "1 minute",
        );
        const end = yield* Clock.currentTimeMillis;

        expect(results.map((r) => r.result)).toEqual([
          { ok: true, status: 200 },
          { ok: true, status: 200 },
        ]);
        expect(browser.visited).toEqual([`${page}#a`]);
        expect(end - start).toBe(4000);
      }),
    );
  });

  it.effect("a fetch 503 persisting in the browser too is 'could not check'", () => {
    const { provide, browser } = setup(() => new Response(null, { status: 503 }));
    browser.status = 503;
    const href = "https://busy.example.com/page";
    return provide(
      Effect.gen(function* () {
        const results = yield* runWithClock(checkLinks({ links: [link(href)] }), "1 minute");

        expect(results[0]?.result).toMatchObject({
          ok: false,
          error: "could not check",
          status: 503,
        });
        // 1 navigation and 2 retries, no more
        expect(browser.visited).toEqual([href, href, href]);
      }),
    );
  });
});

describe("checkLinks() per-host limit", () => {
  it.effect("never sends more than the per-host limit of concurrent requests to a host", () => {
    const active: Record<string, number> = {};
    const max: Record<string, number> = {};
    const { provide } = setup(
      async (url) => {
        const host = new URL(url).hostname;
        active[host] = (active[host] ?? 0) + 1;
        max[host] = Math.max(max[host] ?? 0, active[host]);
        await sleep(5);
        active[host]--;
        return new Response(null, { status: 200 });
      },
      { hostConcurrency: 3 },
    );
    const links = [
      ...Array.from({ length: 30 }, (_, i) => `https://busy.example.com/page-${i}`),
      ...Array.from({ length: 5 }, (_, i) => `https://quiet.example.com/page-${i}`),
    ].map((href) => link(href));
    return provide(
      Effect.gen(function* () {
        const results = yield* checkLinks({ links });

        expect(results).toHaveLength(35);
        expect(results.every((r) => r.result.ok)).toBe(true);
        expect(max["busy.example.com"]).toBe(3);
        expect(max["quiet.example.com"]).toBe(3);
      }),
    );
  });
});

describe("checkLinks() metrics", () => {
  const countersAfter = (links: ReturnType<typeof link>[]) =>
    Effect.gen(function* () {
      yield* checkLinks({ links });
      return (yield* (yield* Metrics).snapshot).counters;
    });

  it.effect("counts total links, unique URLs, unique pages and page fetches", () => {
    const { provide } = setup(() => new Response('<a id="a"></a><a id="b"></a>', { status: 200 }));
    const hrefs = [
      "https://example.com/p#a",
      "https://example.com/p#b",
      "https://example.com/p#a",
      "https://example.com/q",
    ];
    return provide(
      Effect.gen(function* () {
        expect(yield* countersAfter(hrefs.map((href) => link(href)))).toMatchObject({
          totalLinks: 4,
          uniqueUrls: 3,
          uniquePages: 2,
          uniquePagesFetched: 2,
          httpRequests: 2,
        });
      }),
    );
  });

  it.effect("counts every HTTP request (redirect hops) separately from unique pages", () => {
    const { provide } = setup((url) =>
      url === "https://example.com/old"
        ? new Response(null, { status: 301, headers: { Location: "/new" } })
        : new Response("ok", { status: 200 }),
    );
    return provide(
      Effect.gen(function* () {
        // GET /old (301), GET /new (200)
        expect(yield* countersAfter([link("https://example.com/old")])).toMatchObject({
          uniquePagesFetched: 1,
          httpRequests: 2,
        });
      }),
    );
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
