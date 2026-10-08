import { readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Layer, Logger, LogLevel } from "effect";
import { describe, expect } from "vitest";
import { checkLinks, interleaveByHost } from "./link";
import { Metrics } from "./metrics";
import { runWithClock } from "./test/clock";
import { type FetchHandler, fakeFetch } from "./test/fake_fetch";
import { fakeGitHub } from "./test/fake_github";
import { testRunLayer } from "./test/layers";

/**
 * Offline tests for `checkLinks`: real `HostLimiter` and `Metrics`, fake `fetch`. `GitHub` and `Browser` die when used.
 * A link that is re-checked with Playwright ends as "unexpected error" here (dying `Browser`), that is how these tests
 * see the escalation decision. Results of real Playwright re-checks are covered by `playwright_check.test.ts`.
 */

const hashesHtml = readFileSync(join(import.meta.dirname, "__fixtures__", "hashes.html"), "utf8");

const link = (href: string, page = "https://example.com/page") => ({ href, page, text: "link" });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const setup = (handler: FetchHandler, options: { readonly hostConcurrency?: number } = {}) => {
  const fake = fakeFetch(handler);
  const github = fakeGitHub({});
  return {
    calls: fake.calls,
    githubCalls: github.calls,
    provide: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provide(
          testRunLayer({ fetch: fake.layer, github: github.layer, ...options }).pipe(
            Layer.provideMerge(Logger.minimumLogLevel(LogLevel.None)),
          ),
        ),
      ),
  };
};

/** The Playwright re-check ran (and failed, because there is no browser in these tests) */
const isRechecked = (result: { readonly ok: boolean; readonly error?: string }) =>
  result.error === "unexpected error";

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

  // STEP 3: needs the real `checkLinkWithGithubApi` (GITHUB group), it is a stub here
  it.todo("checks each GitHub href only once with the GitHub API");
});

describe("checkLinks() Playwright escalation", () => {
  // STEP 3: these need the real `checkLinkWithGithubApi` (GITHUB group) to produce API results
  it.todo("GitHub API result: %s -> re-checked with Playwright: %s");
  it.todo("checks GitHub code line links with the GitHub API, without the browser");
  it.todo(
    "falls back to the browser for GitHub code line links the API can't check (no token, rate limited)",
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

  for (const href of ["tel:+123", "javascript:void(0)", "data:text/plain,hi"]) {
    it.effect(`never fetches or re-checks non-http(s) URLs like ${href}`, () => {
      const { provide, calls } = setup(() => new Response(null, { status: 200 }));
      return provide(
        Effect.gen(function* () {
          const results = yield* checkLinks({ links: [link(href)] });

          expect(calls).toEqual([]);
          expect(results[0]?.result).toMatchObject({ ok: false, error: "broken link" });
        }),
      );
    });
  }

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

  for (const [name, escalate, handler] of fetchCases) {
    it.effect(`fetch result: ${name} -> re-checked with Playwright: ${escalate}`, () => {
      const { provide } = setup(handler);
      return provide(
        Effect.gen(function* () {
          // The 503 case waits for its retries
          const results = yield* runWithClock(
            checkLinks({ links: [link("https://example.com/some/page")] }),
            "10 seconds",
          );

          expect(results).toHaveLength(1);
          expect(isRechecked(results[0]?.result ?? { ok: true })).toBe(escalate);
        }),
      );
    });
  }

  it.effect(
    "re-checks 'hash not found' from fetch with Playwright (client-side rendered page)",
    () => {
      const { provide } = setup(
        () => new Response("<html><body>Loading...</body></html>", { status: 200 }),
      );
      return provide(
        Effect.gen(function* () {
          const results = yield* checkLinks({ links: [link("https://example.com/spa#rendered")] });

          expect(isRechecked(results[0]?.result ?? { ok: true })).toBe(true);
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
      const { provide, calls, githubCalls } = setup(() => new Response(null, { status: 429 }));
      const hrefs = ["https://github.com/features", "https://github.com/topics/javascript"];
      return provide(
        Effect.gen(function* () {
          const results = yield* checkLinks({ links: hrefs.map((href) => link(href)) });

          expect(githubCalls).toEqual([]);
          expect(calls).toHaveLength(2);
          expect(results.every((r) => isRechecked(r.result))).toBe(true);
        }),
      );
    },
  );

  // STEP 3: need a fake Chromium (BROWSER group) to see the result of the re-check
  it.todo("a link failing with fetch passes when the Playwright re-check passes");
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

  // STEP 3: need a fake Chromium (BROWSER group) to count navigations
  it.todo(
    "navigates once with Playwright for all hashes of a page and checks each hash in the same DOM",
  );
  it.todo("checks GitHub code line links to the same file with one navigation (browser fallback)");
  it.todo("navigates once per page with Playwright, also for repeated hrefs");
  it.todo("finds late anchors of every hash with one navigation and one shared wait");
  it.todo("checkLinks(): a fetch 503 persisting in the browser too is 'could not check'");
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
