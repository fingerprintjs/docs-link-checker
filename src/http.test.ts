import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getReadmeLinks } from "./github/gh_get_links";
import {
  fetchWithHostLimit,
  getRedirectMethod,
  getServerErrorRetryDelay,
  MAX_RATE_LIMIT_RETRIES,
  MAX_REDIRECTS,
  MAX_SERVER_ERROR_RETRIES,
} from "./http";
import { HostLimiter } from "./limiter";
import { checkLinks, checkLinkWithFetch } from "./link";
import { getLinksFromPages, parseLinksFromPage } from "./page";
import { setHostLimiter } from "./utils";
import { checkWebsite } from "./website";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  setHostLimiter(undefined);
  vi.restoreAllMocks();
});

const text = (response: Response) => response.text();

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

/** Stubs `fetch`, handlers get the URL (without the hash) and the request init */
const stubFetch = (handler: Handler) => {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init ?? {}),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const redirect = (location: string, status = 301) =>
  new Response("moved", { status, headers: { Location: location } });

describe("fetchWithHostLimit()", () => {
  it("pauses the host before releasing the slot, so a queued request does not start during Retry-After", async () => {
    setHostLimiter(new HostLimiter(1));
    const events: Array<{ name: string; at: number }> = [];
    let first = true;
    stubFetch((url) => {
      events.push({ name: url, at: Date.now() });
      if (url.endsWith("/a") && first) {
        first = false;
        return new Response(null, { status: 429, headers: { "Retry-After": "1" } });
      }
      return new Response(url.slice(-1), { status: 200 });
    });

    const results = await Promise.all([
      fetchWithHostLimit("https://limited.example.com/a", {}, text),
      fetchWithHostLimit("https://limited.example.com/b", {}, text),
    ]);

    expect(results.map((result) => [result.status, result.data])).toEqual([
      [200, "a"],
      [200, "b"],
    ]);
    const rateLimitedAt = events[0].at;
    const queuedStart = events.find((event) => event.name.endsWith("/b"))!.at;
    expect(queuedStart - rateLimitedAt).toBeGreaterThanOrEqual(950);
  });

  it("returns the last 429 after the retries", async () => {
    setHostLimiter(new HostLimiter(2));
    const fetchMock = stubFetch(
      () => new Response("slow down", { status: 429, headers: { "Retry-After": "0" } }),
    );

    const result = await fetchWithHostLimit("https://limited.example.com/", {}, text);

    expect(result).toMatchObject({ status: 429, data: "slow down" });
    expect(fetchMock).toHaveBeenCalledTimes(MAX_RATE_LIMIT_RETRIES + 1);
  });

  it("does not retry a 429 without a usable Retry-After", async () => {
    setHostLimiter(new HostLimiter(2));
    const fetchMock = stubFetch(() => new Response(null, { status: 429 }));

    expect((await fetchWithHostLimit("https://limited.example.com/", {}, text)).status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("fetchWithHostLimit() server errors (502, 503, 504)", () => {
  /** Runs `request` with fake timers, returns the response and how long it took (simulated time) */
  const withFakeTimers = async <T>(request: () => Promise<T>) => {
    vi.useFakeTimers();
    try {
      const start = Date.now();
      let finishedAt = Number.NaN;
      const promise = request().then((r) => {
        finishedAt = Date.now();
        return r;
      });
      await vi.advanceTimersByTimeAsync(60_000);
      return { response: await promise, took: finishedAt - start };
    } finally {
      vi.useRealTimers();
    }
  };

  it.each([502, 503, 504])(
    "retries a %s with a backoff, then returns the success",
    async (status) => {
      setHostLimiter(new HostLimiter(2));
      let failures = 2;
      const fetchMock = stubFetch(() =>
        failures-- > 0 ? new Response("busy", { status }) : new Response("ok", { status: 200 }),
      );

      const { response, took } = await withFakeTimers(() =>
        fetchWithHostLimit("https://busy.example.com/", {}, text),
      );

      expect(response).toMatchObject({ status: 200, data: "ok" });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      // 2s, then 5s
      expect(took).toBe(7000);
    },
  );

  it("returns the last 503 after the retries, cancelling every unread body", async () => {
    setHostLimiter(new HostLimiter(2));
    let cancelled = 0;
    const fetchMock = stubFetch(
      () =>
        new Response(
          new ReadableStream({
            cancel: () => {
              cancelled++;
            },
          }),
          { status: 503 },
        ),
    );

    const { response } = await withFakeTimers(() =>
      fetchWithHostLimit("https://busy.example.com/", {}, async () => "not read"),
    );

    expect(response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_SERVER_ERROR_RETRIES + 1);
    expect(cancelled).toBe(MAX_SERVER_ERROR_RETRIES + 1);
  });

  it("respects Retry-After (longer than the backoff) and pauses the host for queued requests", async () => {
    setHostLimiter(new HostLimiter(1));
    const events: Array<{ url: string; at: number }> = [];
    let first = true;
    stubFetch((url) => {
      events.push({ url, at: Date.now() });
      if (url.endsWith("/a") && first) {
        first = false;
        return new Response(null, { status: 503, headers: { "Retry-After": "8" } });
      }
      return new Response("ok", { status: 200 });
    });

    const { response, took } = await withFakeTimers(() =>
      Promise.all([
        fetchWithHostLimit("https://busy.example.com/a", {}, text),
        fetchWithHostLimit("https://busy.example.com/b", {}, text),
      ]),
    );

    expect(response.map((r) => r.status)).toEqual([200, 200]);
    // The queued request waited for the pause too
    expect(events.map((event) => [event.url.slice(-1), event.at - events[0].at])).toEqual([
      ["a", 0],
      ["b", 8000],
      ["a", 8000],
    ]);
    expect(took).toBe(8000);
  });

  it("does not retry when Retry-After is longer than the maximum delay", async () => {
    setHostLimiter(new HostLimiter(2));
    const fetchMock = stubFetch(
      () => new Response(null, { status: 503, headers: { "Retry-After": "3600" } }),
    );

    const { response, took } = await withFakeTimers(() =>
      fetchWithHostLimit("https://busy.example.com/", {}, text),
    );

    expect(response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(took).toBe(0);
  });

  it("does not retry with `serverErrorRetries: 0`, or other 5xx statuses", async () => {
    setHostLimiter(new HostLimiter(2));
    const fetchMock = stubFetch(
      (url) => new Response(null, { status: url.endsWith("/500") ? 500 : 503 }),
    );

    await fetchWithHostLimit("https://busy.example.com/503", { serverErrorRetries: 0 }, text);
    await fetchWithHostLimit("https://busy.example.com/500", {}, text);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("getServerErrorRetryDelay() is bounded: backoff, Retry-After as a minimum, at most 10s", () => {
    expect(getServerErrorRetryDelay(0, null)).toBe(2000);
    expect(getServerErrorRetryDelay(1, null)).toBe(5000);
    expect(getServerErrorRetryDelay(2, null)).toBeUndefined();
    expect(getServerErrorRetryDelay(0, "0")).toBe(2000);
    expect(getServerErrorRetryDelay(0, "7")).toBe(7000);
    expect(getServerErrorRetryDelay(1, "10")).toBe(10_000);
    expect(getServerErrorRetryDelay(0, "11")).toBeUndefined();
    expect(getServerErrorRetryDelay(0, "invalid")).toBe(2000);
    expect(getServerErrorRetryDelay(0, null, 0)).toBeUndefined();
  });
});

describe("fetchWithHostLimit() redirects", () => {
  it("follows redirects manually and returns the final status, URL and body", async () => {
    setHostLimiter(new HostLimiter(2));
    const fetchMock = stubFetch((url) => {
      if (url === "https://old.example.com/page")
        return redirect("https://new.example.com/start", 301);
      if (url === "https://new.example.com/start") return redirect("/final?x=1", 307);
      return new Response("final", { status: 200 });
    });

    const result = await fetchWithHostLimit(
      "https://old.example.com/page",
      { method: "HEAD" },
      text,
    );

    expect(result).toMatchObject({
      status: 200,
      url: "https://new.example.com/final?x=1",
      data: "final",
    });
    expect(
      fetchMock.mock.calls.map(([input, init]) => [String(input), init?.method, init?.redirect]),
    ).toEqual([
      ["https://old.example.com/page", "HEAD", "manual"],
      // HEAD stays HEAD on 301 and 307, relative Location is resolved against the current URL
      ["https://new.example.com/start", "HEAD", "manual"],
      ["https://new.example.com/final?x=1", "HEAD", "manual"],
    ]);
  });

  it("respects the per-host limit of the redirect destination", async () => {
    setHostLimiter(new HostLimiter(2));
    let active = 0;
    let maxActive = 0;
    stubFetch(async (url) => {
      if (!url.startsWith("https://destination.example.com/")) {
        // Every source host redirects to the same destination host
        return redirect(`https://destination.example.com/${new URL(url).hostname}`);
      }
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return new Response("ok", { status: 200 });
    });

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        fetchWithHostLimit(`https://source-${i}.example.com/`, {}, text),
      ),
    );

    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(maxActive).toBe(2);
  });

  it("gives up after MAX_REDIRECTS redirects", async () => {
    setHostLimiter(new HostLimiter(2));
    const fetchMock = stubFetch((url) => redirect(`${url}x`, 302));

    await expect(fetchWithHostLimit("https://loop.example.com/", {}, text)).rejects.toThrow(
      "Too many redirects",
    );
    expect(fetchMock).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
  });

  it("reports too many redirects as a broken link in link checks", async () => {
    setHostLimiter(new HostLimiter(2));
    stubFetch((url) => redirect(`${url}x`, 302));

    const result = await checkLinkWithFetch("https://loop.example.com/");

    expect(result).toMatchObject({ ok: false, error: "broken link" });
    expect(result.ok === false && result.errorDetail).toContain("Too many redirects");
  });

  it("switches to GET on 303 (fetch spec)", async () => {
    setHostLimiter(new HostLimiter(2));
    const fetchMock = stubFetch((url) =>
      url.endsWith("/form")
        ? redirect("https://example.com/result", 303)
        : new Response("done", { status: 200 }),
    );

    await fetchWithHostLimit("https://example.com/form", { method: "POST" }, text);

    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "GET"]);
  });

  it.each([
    [303, "POST", "GET"],
    [303, "HEAD", "HEAD"],
    [303, "GET", "GET"],
    [301, "POST", "GET"],
    [302, "POST", "GET"],
    [301, "HEAD", "HEAD"],
    [302, "HEAD", "HEAD"],
    [307, "POST", "POST"],
    [308, "HEAD", "HEAD"],
  ])("getRedirectMethod(%i, %s) is %s", (status, method, expected) => {
    expect(getRedirectMethod(status, method)).toBe(expected);
  });

  it("cancels the body of every redirect response while holding the slot of its host", async () => {
    const limiter = new HostLimiter(1);
    setHostLimiter(limiter);
    const hop = trackedResponse(302, limiter, "https://a.example.com/", {
      Location: "https://b.example.com/",
    });
    stubFetch((url) =>
      url === "https://a.example.com/" ? hop.response : new Response("ok", { status: 200 }),
    );

    const result = await fetchWithHostLimit("https://a.example.com/", {}, text);

    expect(result).toMatchObject({ status: 200, url: "https://b.example.com/" });
    expect(hop.tracking).toEqual({ cancelled: true, slotHeldOnCancel: true });
  });

  it("returns a 3xx without Location as the final response", async () => {
    setHostLimiter(new HostLimiter(2));
    stubFetch(() => new Response(null, { status: 301 }));

    expect((await fetchWithHostLimit("https://example.com/", {}, text)).status).toBe(301);
  });

  it("follows an empty Location (resolves to the current URL), so a self-redirect loop fails", async () => {
    setHostLimiter(new HostLimiter(2));
    const fetchMock = stubFetch(() => redirect("", 302));

    await expect(fetchWithHostLimit("https://self.example.com/", {}, text)).rejects.toThrow(
      "Too many redirects",
    );
    expect(fetchMock).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
  });
});

/**
 * A response whose body stream records if it was cancelled, and whether the request still held its host slot then.
 */
const trackedResponse = (
  status: number,
  limiter: HostLimiter,
  url: string,
  headers?: HeadersInit,
) => {
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

    await fetchWithHostLimit(url, {}, async () => "not read");

    expect(tracking).toEqual({ cancelled: true, slotHeldOnCancel: true });
  });

  it("a source page that fails (404) has its body cancelled and is reported as an error", async () => {
    const limiter = new HostLimiter(1);
    setHostLimiter(limiter);
    const url = "https://docs.example.com/missing";
    const { response, tracking } = trackedResponse(404, limiter, url);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

    await expect(parseLinksFromPage(url)).rejects.toThrow("status: 404");
    expect(tracking).toEqual({ cancelled: true, slotHeldOnCancel: true });
  });

  it("a failed README download has its body cancelled", async () => {
    const limiter = new HostLimiter(1);
    setHostLimiter(limiter);
    const url = "https://raw.githubusercontent.com/org/repo/main/README.md";
    const { response, tracking } = trackedResponse(500, limiter, url);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

    const links = await getReadmeLinks([
      { sourcePath: "https://github.com/org/repo/blob/main/README.md", downloadUrl: url },
    ]);

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
      vi.fn(async (_input: string | URL, init?: RequestInit) =>
        init?.method === "HEAD" ? head.response : get.response,
      ),
    );

    expect(await checkLinkWithFetch(url)).toEqual({ ok: true, status: 200 });
    expect(head.tracking).toEqual({ cancelled: true, slotHeldOnCancel: true });
    expect(get.tracking).toEqual({ cancelled: true, slotHeldOnCancel: true });
  });
});

describe("invalid LINK_CHECK_HOST_CONCURRENCY", () => {
  it.each([
    [
      "checkLinks",
      () =>
        checkLinks({
          links: [{ href: "https://example.com/", page: "https://example.com", text: "" }],
        }),
    ],
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
          : new Response(html, { status: 200 }),
      ),
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
          : new Response(html, { status: 200 }),
      ),
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
