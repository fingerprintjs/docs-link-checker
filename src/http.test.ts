import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkLinkWithFetch } from "./fetch_check";
import { fetchWithHostLimit, planServerErrorRetry, readText } from "./http";
import { HostLimiter } from "./limiter";
import { type RunServices, withRun } from "./run";
import { FetchError, TimeoutError, TooManyRedirects } from "./utils/errors";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

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

/** Runs `effect` in a run of its own (per-host limit of `hostConcurrency`) */
const runInRun = <A, E>(effect: Effect.Effect<A, E, RunServices>, hostConcurrency = 2) =>
  Effect.runPromise(effect.pipe(withRun({ hostConcurrency })));

/** Runs `effect` with fake timers, returns its result and how long it took (simulated time) */
const withFakeTimers = async <A, E>(
  effect: Effect.Effect<A, E, RunServices>,
  hostConcurrency = 2,
) => {
  vi.useFakeTimers();
  try {
    const start = Date.now();
    let finishedAt = Number.NaN;
    const promise = runInRun(effect, hostConcurrency).then((result) => {
      finishedAt = Date.now();
      return result;
    });
    await vi.advanceTimersByTimeAsync(60_000);
    return { response: await promise, took: finishedAt - start };
  } finally {
    vi.useRealTimers();
  }
};

/** Starts `onStart` as a request to the host of `url`, it only runs once a slot of the host is free */
type ProbeSlot = (url: string, onStart: () => void) => void;

/**
 * A response whose body stream records if it was cancelled, and whether the request still held its host slot then.
 */
const trackedResponse = (
  probeSlot: ProbeSlot,
  status: number,
  url: string,
  headers?: HeadersInit,
) => {
  const tracking = { cancelled: false, slotHeldOnCancel: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode("chunk"));
    },
    async cancel() {
      tracking.cancelled = true;
      // A request queued now starts only if the slot is already released
      let probeStarted = false;
      probeSlot(url, () => {
        probeStarted = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      tracking.slotHeldOnCancel = !probeStarted;
    },
  });
  return { response: new Response(body, { status, headers }), tracking };
};

const fetchText = (url: string, options: Parameters<typeof fetchWithHostLimit>[1] = {}) =>
  fetchWithHostLimit(url, options, readText);

describe("fetchWithHostLimit()", () => {
  it("pauses the host before releasing the slot, so a queued request does not start during Retry-After", async () => {
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

    const { response: results } = await withFakeTimers(
      Effect.all(
        [fetchText("https://limited.example.com/a"), fetchText("https://limited.example.com/b")],
        { concurrency: "unbounded" },
      ),
      1,
    );

    expect(results.map((result) => [result.status, result.data])).toEqual([
      [200, "a"],
      [200, "b"],
    ]);
    const rateLimitedAt = events[0]!.at;
    const queuedStart = events.find((event) => event.name.endsWith("/b"))!.at;
    expect(queuedStart - rateLimitedAt).toBe(1000);
  });

  it("returns the last 429 after the retries", async () => {
    const fetchMock = stubFetch(
      () => new Response("slow down", { status: 429, headers: { "Retry-After": "0" } }),
    );

    const result = await runInRun(fetchText("https://limited.example.com/"));

    expect(result).toMatchObject({ status: 429, data: "slow down" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry a 429 without a usable Retry-After", async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 429 }));

    expect((await runInRun(fetchText("https://limited.example.com/"))).status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails with a FetchError when the request fails", async () => {
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });

    const error = await runInRun(Effect.flip(fetchText("https://down.example.com/")));

    expect(error).toBeInstanceOf(FetchError);
    expect(String(error)).toBe("TypeError: fetch failed");
  });

  it("interrupts a request that takes longer than the timeout, aborting its fetch", async () => {
    let signal: AbortSignal | null | undefined;
    stubFetch((_url, init) => {
      signal = init.signal;
      // Never answers, settles only when aborted
      return new Promise<Response>((_resolve, reject) =>
        init.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    });

    const { response: error } = await withFakeTimers(
      Effect.flip(fetchText("https://hang.example.com/", { timeoutMs: 1000 })),
    );

    expect(error).toBeInstanceOf(TimeoutError);
    expect(signal?.aborted).toBe(true);
  });

  it("frees the host slot of a request that timed out", async () => {
    stubFetch((url) =>
      url.endsWith("/hang") ? new Promise<Response>(() => {}) : new Response("ok", { status: 200 }),
    );

    const { response } = await withFakeTimers(
      Effect.gen(function* () {
        yield* Effect.flip(fetchText("https://hang.example.com/hang", { timeoutMs: 1000 }));
        return yield* fetchText("https://hang.example.com/next");
      }),
      1,
    );

    expect(response.status).toBe(200);
  });
});

describe("fetchWithHostLimit() server errors (502, 503, 504)", () => {
  it.each([502, 503, 504])(
    "retries a %s with a backoff, then returns the success",
    async (status) => {
      let failures = 2;
      const fetchMock = stubFetch(() =>
        failures-- > 0 ? new Response("busy", { status }) : new Response("ok", { status: 200 }),
      );

      const { response, took } = await withFakeTimers(fetchText("https://busy.example.com/"));

      expect(response).toMatchObject({ status: 200, data: "ok" });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      // 2s, then 5s
      expect(took).toBe(7000);
    },
  );

  it("returns the last 503 after the retries, cancelling every unread body", async () => {
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

    const { response } = await withFakeTimers(
      fetchWithHostLimit("https://busy.example.com/", {}, () => Effect.succeed("not read")),
    );

    expect(response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(cancelled).toBe(3);
  });

  it("respects Retry-After (longer than the backoff) and pauses the host for queued requests", async () => {
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

    const { response, took } = await withFakeTimers(
      Effect.all(
        [fetchText("https://busy.example.com/a"), fetchText("https://busy.example.com/b")],
        { concurrency: "unbounded" },
      ),
      1,
    );

    expect(response.map((r) => r.status)).toEqual([200, 200]);
    // The queued request waited for the pause too (it and the retry of "a" start at the same time, in any order)
    expect(events[0]!.url.endsWith("/a")).toBe(true);
    expect(
      events
        .slice(1)
        .map((event) => `${event.url.slice(-1)}@${event.at - events[0]!.at}`)
        .toSorted(),
    ).toEqual(["a@8000", "b@8000"]);
    expect(took).toBe(8000);
  });

  it("does not retry when Retry-After is longer than the maximum delay", async () => {
    const fetchMock = stubFetch(
      () => new Response(null, { status: 503, headers: { "Retry-After": "3600" } }),
    );

    const { response, took } = await withFakeTimers(fetchText("https://busy.example.com/"));

    expect(response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(took).toBe(0);
  });

  it("does not retry other 5xx statuses", async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 500 }));

    await runInRun(fetchText("https://busy.example.com/500"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Also used by the Playwright check. Fetch-level tests above cover the backoff steps and the give-up cases
  it("planServerErrorRetry() edge cases: Retry-After of exactly 10s is allowed, invalid is ignored", () =>
    runInRun(
      Effect.gen(function* () {
        const delay = (retries: number, retryAfter: string | null) =>
          planServerErrorRetry("https://busy.example.com/", 503, retries, retryAfter);
        expect(yield* delay(1, "10")).toBe(10_000);
        expect(yield* delay(0, "11")).toBeUndefined();
        expect(yield* delay(0, "invalid")).toBe(2000);
      }),
    ));
});

describe("fetchWithHostLimit() redirects", () => {
  it("follows redirects manually and returns the final status, URL and body", async () => {
    const fetchMock = stubFetch((url) => {
      if (url === "https://old.example.com/page")
        return redirect("https://new.example.com/start", 301);
      if (url === "https://new.example.com/start") return redirect("/final?x=1", 307);
      return new Response("final", { status: 200 });
    });

    const result = await runInRun(fetchText("https://old.example.com/page", { method: "HEAD" }));

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

    const results = await runInRun(
      Effect.all(
        Array.from({ length: 12 }, (_, i) => fetchText(`https://source-${i}.example.com/`)),
        { concurrency: "unbounded" },
      ),
    );

    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(maxActive).toBe(2);
  });

  it("gives up after 10 redirects", async () => {
    const fetchMock = stubFetch((url) => redirect(`${url}x`, 302));

    const error = await runInRun(Effect.flip(fetchText("https://loop.example.com/")));

    expect(error).toBeInstanceOf(TooManyRedirects);
    expect(error.message).toContain("Too many redirects");
    expect(fetchMock).toHaveBeenCalledTimes(11);
  });

  it("reports too many redirects as a broken link in link checks", async () => {
    stubFetch((url) => redirect(`${url}x`, 302));

    const result = await runInRun(checkLinkWithFetch("https://loop.example.com/"));

    expect(result).toMatchObject({ ok: false, error: "broken link" });
    expect(!result.ok && result.errorDetail).toContain("Too many redirects");
  });

  it("cancels the body of every redirect response while holding the slot of its host", async () => {
    const result = await runInRun(
      Effect.gen(function* () {
        const limiter = yield* HostLimiter;
        const hop = trackedResponse(
          (url, onStart) => void Effect.runFork(limiter.run(url, Effect.sync(onStart))),
          302,
          "https://a.example.com/",
          { Location: "https://b.example.com/" },
        );
        stubFetch((url) =>
          url === "https://a.example.com/" ? hop.response : new Response("ok", { status: 200 }),
        );
        return { result: yield* fetchText("https://a.example.com/"), tracking: hop.tracking };
      }),
      1,
    );

    expect(result.result).toMatchObject({ status: 200, url: "https://b.example.com/" });
    expect(result.tracking).toEqual({ cancelled: true, slotHeldOnCancel: true });
  });

  it("returns a 3xx without Location as the final response", async () => {
    stubFetch(() => new Response(null, { status: 301 }));

    expect((await runInRun(fetchText("https://example.com/"))).status).toBe(301);
  });

  it("follows an empty Location (resolves to the current URL), so a self-redirect loop fails", async () => {
    const fetchMock = stubFetch(() => redirect("", 302));

    const error = await runInRun(Effect.flip(fetchText("https://self.example.com/")));

    expect(error).toBeInstanceOf(TooManyRedirects);
    expect(fetchMock).toHaveBeenCalledTimes(11);
  });
});

describe("unread response bodies are cancelled before the host slot is released", () => {
  it("fetchWithHostLimit cancels a body the reader did not consume", async () => {
    const url = "https://example.com/big-file";
    const tracking = await runInRun(
      Effect.gen(function* () {
        const limiter = yield* HostLimiter;
        const tracked = trackedResponse(
          (probeUrl, onStart) => void Effect.runFork(limiter.run(probeUrl, Effect.sync(onStart))),
          200,
          url,
        );
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => tracked.response),
        );
        yield* fetchWithHostLimit(url, {}, () => Effect.succeed("not read"));
        return tracked.tracking;
      }),
      1,
    );

    expect(tracking).toEqual({ cancelled: true, slotHeldOnCancel: true });
  });

  it("link checks cancel the GET body when it is not needed", async () => {
    const url = "https://example.com/big-file";
    const { result, tracking } = await runInRun(
      Effect.gen(function* () {
        const limiter = yield* HostLimiter;
        const tracked = trackedResponse(
          (probeUrl, onStart) => void Effect.runFork(limiter.run(probeUrl, Effect.sync(onStart))),
          200,
          url,
        );
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => tracked.response),
        );
        const checked = yield* checkLinkWithFetch(url);
        return { result: checked, tracking: tracked.tracking };
      }),
      1,
    );

    expect(result).toEqual({ ok: true, status: 200 });
    expect(tracking).toEqual({ cancelled: true, slotHeldOnCancel: true });
  });
});
