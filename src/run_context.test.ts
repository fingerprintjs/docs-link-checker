import { describe, it, expect, vi, afterEach } from "vitest";
import { formatRunMetrics, getRunContext, incrementMetric, runCached, timePhase } from "./run_context";
import { withRun } from "./run";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("run context", () => {
  it("nested runs join the outer run", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await withRun(async () => {
      const outer = getRunContext();
      await withRun(async () => {
        expect(getRunContext()).toBe(outer);
      });
    });
    expect(getRunContext()).toBeUndefined();
  });

  it("logs metrics and phase timings at the end of the run", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await withRun(async () => {
      incrementMetric("totalLinks", 10);
      incrementMetric("uniqueUrls", 4);
      incrementMetric("playwrightNavigations");
      await timePhase("Check links", async () => {});
    });

    const output = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
    expect(output).toContain("Run metrics:");
    expect(output).toContain("Total links: 10");
    expect(output).toContain("Unique URLs: 4");
    expect(output).toContain("Playwright navigations: 1");
    expect(output).toMatch(/Check links: \d+ms/);
    expect(output).toMatch(/Total: \d+/);
  });

  it("metrics and caching are no-ops outside of a run", async () => {
    incrementMetric("totalLinks");
    const fn = vi.fn(async () => 1);
    await runCached("key", fn);
    await runCached("key", fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("formats metrics", () => {
    expect(
      formatRunMetrics({ counters: { httpRequests: 3 }, phases: [{ name: "Extract links", ms: 1500 }] }, 2000)
    ).toBe(
      "Run metrics:\n  HTTP requests (incl. redirects, retries and HEAD-to-GET fallbacks): 3\n  Phases:\n    Extract links: 1.5s\n  Total: 2.0s"
    );
  });
});

describe("checkLinks() metrics", () => {
  it("counts total links, unique URLs, unique pages and page fetches", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response('<a id="a"></a><a id="b"></a>', { status: 200 })));
    const { checkLinks } = await import("./link");
    const hrefs = ["https://example.com/p#a", "https://example.com/p#b", "https://example.com/p#a", "https://example.com/q"];

    const counters = await withRun(async () => {
      await checkLinks({ links: hrefs.map((href) => ({ href, page: "https://example.com", text: "" })) });
      return getRunContext()!.metrics.counters;
    });

    expect(counters).toMatchObject({ totalLinks: 4, uniqueUrls: 3, uniquePages: 2, uniquePagesFetched: 2, httpRequests: 2 });
  });

  it("counts every HTTP request (redirect hops, HEAD-to-GET fallbacks) separately from unique pages", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "https://example.com/old") return new Response(null, { status: 301, headers: { Location: "/new" } });
        // The redirect target refuses HEAD
        return init?.method === "HEAD" ? new Response(null, { status: 405 }) : new Response("ok", { status: 200 });
      })
    );
    const { checkLinks } = await import("./link");

    const counters = await withRun(async () => {
      await checkLinks({ links: [{ href: "https://example.com/old", page: "https://example.com", text: "" }] });
      return getRunContext()!.metrics.counters;
    });

    // HEAD /old (301), HEAD /new (405), then the GET fallback: GET /old (301), GET /new (200)
    expect(counters).toMatchObject({ uniquePagesFetched: 1, httpRequests: 4 });
  });
});
