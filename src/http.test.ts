import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkLinkWithFetch } from "./fetch_check";
import { fetchWithHostLimit, planServerErrorRetry } from "./http";
import { getHostLimiter, withRun } from "./run";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const text = (response: Response) => response.text();

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

let fakeFetch: typeof fetch;

/** Runs `fn` as a run whose `fetch` is the one set by `stubFetch` (which can be called inside of `fn`) */
const run = <T>(hostConcurrency: number, fn: () => Promise<T>) =>
  withRun({ hostConcurrency, deps: { fetch: (input, init) => fakeFetch(input, init) } }, fn);

/** Fakes `fetch`, handlers get the URL (without the hash) and the request init */
const stubFetch = (handler: Handler) => {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init ?? {}),
  );
  fakeFetch = fetchMock;
  return fetchMock;
};

const redirect = (location: string, status = 301) =>
  new Response("moved", { status, headers: { Location: location } });

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

describe("fetchWithHostLimit()", () => {
  it("pauses the host before releasing the slot, so a queued request does not start during Retry-After", () =>
    run(1, async () => {
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

      const { response: results } = await withFakeTimers(() =>
        Promise.all([
          fetchWithHostLimit("https://limited.example.com/a", {}, text),
          fetchWithHostLimit("https://limited.example.com/b", {}, text),
        ]),
      );

      expect(results.map((result) => [result.status, result.data])).toEqual([
        [200, "a"],
        [200, "b"],
      ]);
      const rateLimitedAt = events[0]!.at;
      const queuedStart = events.find((event) => event.name.endsWith("/b"))!.at;
      expect(queuedStart - rateLimitedAt).toBe(1000);
    }));

  it("returns the last 429 after the retries", () =>
    run(2, async () => {
      const fetchMock = stubFetch(
        () => new Response("slow down", { status: 429, headers: { "Retry-After": "0" } }),
      );

      const result = await fetchWithHostLimit("https://limited.example.com/", {}, text);

      expect(result).toMatchObject({ status: 429, data: "slow down" });
      // The request, then 2 retries
      expect(fetchMock).toHaveBeenCalledTimes(3);
    }));

  it("does not retry a 429 without a usable Retry-After", () =>
    run(2, async () => {
      const fetchMock = stubFetch(() => new Response(null, { status: 429 }));

      expect((await fetchWithHostLimit("https://limited.example.com/", {}, text)).status).toBe(429);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }));
});

describe("fetchWithHostLimit() server errors (502, 503, 504)", () => {
  it.each([502, 503, 504])("retries a %s with a backoff, then returns the success", (status) =>
    run(2, async () => {
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
    }),
  );

  it("returns the last 503 after the retries, cancelling every unread body", () =>
    run(2, async () => {
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
      // The request, then 2 retries
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(cancelled).toBe(3);
    }));

  it("respects Retry-After (longer than the backoff) and pauses the host for queued requests", () =>
    run(1, async () => {
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
      expect(events.map((event) => [event.url.slice(-1), event.at - events[0]!.at])).toEqual([
        ["a", 0],
        ["b", 8000],
        ["a", 8000],
      ]);
      expect(took).toBe(8000);
    }));

  it("does not retry when Retry-After is longer than the maximum delay", () =>
    run(2, async () => {
      const fetchMock = stubFetch(
        () => new Response(null, { status: 503, headers: { "Retry-After": "3600" } }),
      );

      const { response, took } = await withFakeTimers(() =>
        fetchWithHostLimit("https://busy.example.com/", {}, text),
      );

      expect(response.status).toBe(503);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(took).toBe(0);
    }));

  it("does not retry other 5xx statuses", () =>
    run(2, async () => {
      const fetchMock = stubFetch(() => new Response(null, { status: 500 }));

      await fetchWithHostLimit("https://busy.example.com/500", {}, text);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    }));

  // Also used by the Playwright check. Fetch-level tests above cover the backoff steps and the give-up cases
  it("planServerErrorRetry() edge cases: Retry-After of exactly 10s is allowed, invalid is ignored", () => {
    const delay = (retries: number, retryAfter: string | null) =>
      planServerErrorRetry("https://busy.example.com/", 503, retries, retryAfter);
    expect(delay(1, "10")).toBe(10_000);
    expect(delay(0, "11")).toBeUndefined();
    expect(delay(0, "invalid")).toBe(2000);
  });
});

describe("fetchWithHostLimit() redirects", () => {
  it("follows redirects manually and returns the final status, URL and body", () =>
    run(2, async () => {
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
      expect(fetchMock.mock.calls.map(([input, init]) => [String(input), init?.method])).toEqual([
        ["https://old.example.com/page", "HEAD"],
        // HEAD stays HEAD on 301 and 307, relative Location is resolved against the current URL
        ["https://new.example.com/start", "HEAD"],
        ["https://new.example.com/final?x=1", "HEAD"],
      ]);
    }));

  it("respects the per-host limit of the redirect destination", () =>
    run(2, async () => {
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
    }));

  it("gives up after 10 redirects", () =>
    run(2, async () => {
      const fetchMock = stubFetch((url) => redirect(`${url}x`, 302));

      await expect(fetchWithHostLimit("https://loop.example.com/", {}, text)).rejects.toThrow(
        "Too many redirects",
      );
      expect(fetchMock).toHaveBeenCalledTimes(11);
    }));

  it("reports too many redirects as a broken link in link checks", () =>
    run(2, async () => {
      stubFetch((url) => redirect(`${url}x`, 302));

      const result = await checkLinkWithFetch("https://loop.example.com/");

      expect(result).toMatchObject({ ok: false, error: "broken link" });
      expect(!result.ok && result.errorDetail).toContain("Too many redirects");
    }));

  it("cancels the body of every redirect response while holding the slot of its host", () =>
    run(1, async () => {
      const hop = trackedResponse(302, "https://a.example.com/", {
        Location: "https://b.example.com/",
      });
      stubFetch((url) =>
        url === "https://a.example.com/" ? hop.response : new Response("ok", { status: 200 }),
      );

      const result = await fetchWithHostLimit("https://a.example.com/", {}, text);

      expect(result).toMatchObject({ status: 200, url: "https://b.example.com/" });
      expect(hop.tracking).toEqual({ cancelled: true, slotHeldOnCancel: true });
    }));

  it("returns a 3xx without Location as the final response", () =>
    run(2, async () => {
      stubFetch(() => new Response(null, { status: 301 }));

      expect((await fetchWithHostLimit("https://example.com/", {}, text)).status).toBe(301);
    }));

  it("follows an empty Location (resolves to the current URL), so a self-redirect loop fails", () =>
    run(2, async () => {
      const fetchMock = stubFetch(() => redirect("", 302));

      await expect(fetchWithHostLimit("https://self.example.com/", {}, text)).rejects.toThrow(
        "Too many redirects",
      );
      expect(fetchMock).toHaveBeenCalledTimes(11);
    }));
});

/**
 * A response whose body stream records if it was cancelled, and whether the request still held its host slot then.
 */
const trackedResponse = (status: number, url: string, headers?: HeadersInit) => {
  const limiter = getHostLimiter();
  const tracking = { cancelled: false, slotHeldOnCancel: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode("chunk"));
    },
    async cancel() {
      tracking.cancelled = true;
      // A request queued now starts only if the slot is already released
      let probeStarted = false;
      void limiter.run(url, async () => {
        probeStarted = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      tracking.slotHeldOnCancel = !probeStarted;
    },
  });
  return { response: new Response(body, { status, headers }), tracking };
};

describe("unread response bodies are cancelled before the host slot is released", () => {
  it("fetchWithHostLimit cancels a body the reader did not consume", () =>
    run(1, async () => {
      const url = "https://example.com/big-file";
      const { response, tracking } = trackedResponse(200, url);
      stubFetch(() => response);

      await fetchWithHostLimit(url, {}, async () => "not read");

      expect(tracking).toEqual({ cancelled: true, slotHeldOnCancel: true });
    }));

  it("link checks cancel the GET body when it is not needed", () =>
    run(1, async () => {
      const url = "https://example.com/big-file";
      const get = trackedResponse(200, url);
      stubFetch(() => get.response);

      expect(await checkLinkWithFetch(url)).toEqual({ ok: true, status: 200 });
      expect(get.tracking).toEqual({ cancelled: true, slotHeldOnCancel: true });
    }));
});
