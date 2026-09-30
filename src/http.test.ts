import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchWithHostLimit, MAX_RATE_LIMIT_RETRIES } from "./http";
import { HostLimiter } from "./limiter";
import { setHostLimiter } from "./utils";
import { getLinksFromPages, parseLinksFromPage } from "./page";

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
