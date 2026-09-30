import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchWithHostLimit, MAX_RATE_LIMIT_RETRIES } from "./http";
import { HostLimiter } from "./limiter";
import { setHostLimiter } from "./utils";
import { getLinksFromPages, parseLinksFromPage } from "./page";
import { checkLinks, checkLinkWithFetch } from "./link";
import { checkWebsite } from "./website";
import { getReadmeLinks } from "./github/gh_get_links";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  setHostLimiter(undefined);
  vi.restoreAllMocks();
});

const text = (response: Response) => response.text();

describe("fetchWithHostLimit()", () => {
  it("pauses the host before releasing the slot, so a queued request does not start during Retry-After", async () => {
    setHostLimiter(new HostLimiter(1));
    const events: Array<{ name: string; at: number }> = [];
    let first = true;
    const rateLimitedRequest = async () => {
      events.push({ name: "a", at: Date.now() });
      if (first) {
        first = false;
        return new Response(null, { status: 429, headers: { "Retry-After": "1" } });
      }
      return new Response("a", { status: 200 });
    };
    const queuedRequest = async () => {
      events.push({ name: "b", at: Date.now() });
      return new Response("b", { status: 200 });
    };

    const results = await Promise.all([
      fetchWithHostLimit("https://limited.example.com/a", rateLimitedRequest, text),
      fetchWithHostLimit("https://limited.example.com/b", queuedRequest, text),
    ]);

    expect(results.map((result) => [result.status, result.data])).toEqual([
      [200, "a"],
      [200, "b"],
    ]);
    const rateLimitedAt = events[0].at;
    const queuedStart = events.find((event) => event.name === "b")!.at;
    expect(queuedStart - rateLimitedAt).toBeGreaterThanOrEqual(950);
  });

  it("returns the last 429 after the retries", async () => {
    setHostLimiter(new HostLimiter(2));
    const request = vi.fn(async () => new Response("slow down", { status: 429, headers: { "Retry-After": "0" } }));

    const result = await fetchWithHostLimit("https://limited.example.com/", request, text);

    expect(result).toMatchObject({ status: 429, data: "slow down" });
    expect(request).toHaveBeenCalledTimes(MAX_RATE_LIMIT_RETRIES + 1);
  });

  it("does not retry a 429 without a usable Retry-After", async () => {
    setHostLimiter(new HostLimiter(2));
    const request = vi.fn(async () => new Response(null, { status: 429 }));

    expect((await fetchWithHostLimit("https://limited.example.com/", request, text)).status).toBe(429);
    expect(request).toHaveBeenCalledTimes(1);
  });
});

/**
 * A response whose body stream records if it was cancelled, and whether the request still held its host slot then.
 */
const trackedResponse = (status: number, limiter: HostLimiter, url: string, headers?: HeadersInit) => {
  const tracking = { cancelled: false, slotHeldOnCancel: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode("chunk"));
    },
    cancel() {
      tracking.cancelled = true;
      tracking.slotHeldOnCancel = limiter.activeCount(url) === 1;
    },
  });
  return { response: new Response(body, { status, headers }), tracking };
};

describe("unread response bodies are cancelled before the host slot is released", () => {
  it("fetchWithHostLimit cancels a body the reader did not consume", async () => {
    const limiter = new HostLimiter(1);
    setHostLimiter(limiter);
    const url = "https://example.com/big-file";
    const { response, tracking } = trackedResponse(200, limiter, url);

    await fetchWithHostLimit(url, async () => response, async () => "not read");

    expect(tracking).toEqual({ cancelled: true, slotHeldOnCancel: true });
  });

  it("a source page that fails (404) has its body cancelled and is reported as an error", async () => {
    const limiter = new HostLimiter(1);
    setHostLimiter(limiter);
    const url = "https://docs.example.com/missing";
    const { response, tracking } = trackedResponse(404, limiter, url);
    vi.stubGlobal("fetch", vi.fn(async () => response));

    await expect(parseLinksFromPage(url)).rejects.toThrow("status: 404");
    expect(tracking).toEqual({ cancelled: true, slotHeldOnCancel: true });
  });

  it("a failed README download has its body cancelled", async () => {
    const limiter = new HostLimiter(1);
    setHostLimiter(limiter);
    const url = "https://raw.githubusercontent.com/org/repo/main/README.md";
    const { response, tracking } = trackedResponse(500, limiter, url);
    vi.stubGlobal("fetch", vi.fn(async () => response));

    const links = await getReadmeLinks([{ sourcePath: "https://github.com/org/repo/blob/main/README.md", downloadUrl: url }]);

    expect(links).toEqual([]);
    expect(tracking).toEqual({ cancelled: true, slotHeldOnCancel: true });
  });

  it("link checks cancel both the HEAD body before the GET fallback and the unneeded GET body", async () => {
    const limiter = new HostLimiter(1);
    setHostLimiter(limiter);
    const url = "https://example.com/no-head";
    const head = trackedResponse(405, limiter, url);
    const get = trackedResponse(200, limiter, url);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL, init?: RequestInit) => (init?.method === "HEAD" ? head.response : get.response))
    );

    expect(await checkLinkWithFetch(url)).toEqual({ ok: true, status: 200 });
    expect(head.tracking).toEqual({ cancelled: true, slotHeldOnCancel: true });
    expect(get.tracking).toEqual({ cancelled: true, slotHeldOnCancel: true });
  });
});

describe("invalid LINK_CHECK_HOST_CONCURRENCY", () => {
  it.each([
    ["checkLinks", () => checkLinks({ links: [{ href: "https://example.com/", page: "https://example.com", text: "" }] })],
    ["checkWebsite", () => checkWebsite({ websiteUrl: "https://example.com" })],
  ])("%s fails before doing any work", async (_name, run) => {
    setHostLimiter(undefined);
    vi.stubEnv("LINK_CHECK_HOST_CONCURRENCY", "abc");
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(run()).rejects.toThrow('Invalid LINK_CHECK_HOST_CONCURRENCY "abc"');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("page link extraction and rate limiting", () => {
  const html = '<a href="https://example.com/target">Target</a>';

  it("retries a source page after a 429 with Retry-After instead of returning no links", async () => {
    setHostLimiter(new HostLimiter(2));
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ++calls === 1
          ? new Response(null, { status: 429, headers: { "Retry-After": "0" } })
          : new Response(html, { status: 200 })
      )
    );

    const links = await parseLinksFromPage("https://docs.example.com/page");

    expect(calls).toBe(2);
    expect(links.map((link) => link.href)).toEqual(["https://example.com/target"]);
  });

  it("reports a page that still fails after the retries as an extraction error (not silently empty)", async () => {
    setHostLimiter(new HostLimiter(2));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) =>
        String(input).endsWith("/limited")
          ? new Response(null, { status: 429, headers: { "Retry-After": "0" } })
          : new Response(html, { status: 200 })
      )
    );

    const { links, errors } = await getLinksFromPages({
      pages: ["https://docs.example.com/limited", "https://docs.example.com/ok"],
    });

    expect(links).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].item).toBe("https://docs.example.com/limited");
    expect(errors[0].message).toContain("status: 429");
  });
});
