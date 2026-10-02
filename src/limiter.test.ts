import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HostLimiter,
  parseHostConcurrency,
  parseRetryAfter,
  Semaphore,
  withTimeout,
} from "./limiter";
import { setHostLimiter } from "./run";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `count` tasks through `run` and returns the maximum number of tasks running at the same time */
const measureConcurrency = async (
  count: number,
  run: (task: () => Promise<void>, i: number) => Promise<void>,
) => {
  let active = 0;
  let max = 0;
  await Promise.all(
    Array.from({ length: count }, (_, i) =>
      run(async () => {
        active++;
        max = Math.max(max, active);
        await sleep(5);
        active--;
      }, i),
    ),
  );
  return max;
};

describe("Semaphore", () => {
  it("runs at most `limit` tasks at the same time", async () => {
    const semaphore = new Semaphore(3);
    expect(await measureConcurrency(20, (task) => semaphore.run(task))).toBe(3);
    expect(semaphore.activeCount).toBe(0);
    expect(semaphore.waitingCount).toBe(0);
  });

  it("releases the slot when a task throws", async () => {
    const semaphore = new Semaphore(1);
    await expect(semaphore.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
    await expect(semaphore.run(async () => "next")).resolves.toBe("next");
  });

  it("rejects invalid limits", () => {
    expect(() => new Semaphore(0)).toThrow("Semaphore limit must be a positive integer");
  });
});

describe("HostLimiter", () => {
  it("limits concurrency per host, hosts are independent", async () => {
    const limiter = new HostLimiter(2);
    const perHost: Record<string, { active: number; max: number }> = {};
    let totalMax = 0;
    let totalActive = 0;

    const urls = Array.from(
      { length: 30 },
      (_, i) => `https://host-${i % 3}.example.com/page-${i}`,
    );
    await Promise.all(
      urls.map((url) =>
        limiter.run(url, async () => {
          const host = new URL(url).hostname;
          perHost[host] ??= { active: 0, max: 0 };
          perHost[host].active++;
          perHost[host].max = Math.max(perHost[host].max, perHost[host].active);
          totalActive++;
          totalMax = Math.max(totalMax, totalActive);
          await sleep(5);
          perHost[host].active--;
          totalActive--;
        }),
      ),
    );

    expect(Object.values(perHost).map((host) => host.max)).toEqual([2, 2, 2]);
    // Different hosts run in parallel
    expect(totalMax).toBe(6);
  });

  it("delays new requests to a paused host", async () => {
    const limiter = new HostLimiter(5);
    limiter.pause("https://paused.example.com/a", 50);
    const start = Date.now();
    await limiter.run("https://paused.example.com/b", async () => {});
    expect(Date.now() - start).toBeGreaterThanOrEqual(45);

    // Other hosts are not affected
    const otherStart = Date.now();
    await limiter.run("https://other.example.com/", async () => {});
    expect(Date.now() - otherStart).toBeLessThan(40);
  });

  it("waitUntilResumed() waits for a pause without taking a slot", async () => {
    const limiter = new HostLimiter(1);
    let release!: () => void;
    // The only slot stays busy, waitUntilResumed must not wait for it
    const busy = limiter.run(
      "https://paused.example.com/",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    // Let the busy request start before the pause
    await new Promise((resolve) => setTimeout(resolve, 0));
    limiter.pause("https://paused.example.com/a", 50);
    const start = Date.now();
    await limiter.waitUntilResumed("https://paused.example.com/b");
    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
    expect(limiter.activeCount("https://paused.example.com/")).toBe(1);

    const otherStart = Date.now();
    await limiter.waitUntilResumed("https://other.example.com/");
    await limiter.waitUntilResumed("not a url");
    expect(Date.now() - otherStart).toBeLessThan(40);
    release();
    await busy;
  });

  it("does not limit invalid URLs", async () => {
    const limiter = new HostLimiter(1);
    await expect(limiter.run("not a url", async () => "ok")).resolves.toBe("ok");
  });
});

describe("parseRetryAfter()", () => {
  it("parses seconds and HTTP dates", () => {
    expect(parseRetryAfter("30")).toBe(30000);
    const now = Date.parse("2025-01-01T00:00:00Z");
    expect(parseRetryAfter("Wed, 01 Jan 2025 00:00:10 GMT", now)).toBe(10000);
    expect(parseRetryAfter("Tue, 31 Dec 2024 00:00:00 GMT", now)).toBe(0);
  });

  it("returns undefined for missing or invalid values", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });
});

describe("withTimeout()", () => {
  it("rejects when the promise takes too long", async () => {
    await expect(withTimeout(sleep(50), 5, "too slow")).rejects.toThrow("too slow");
    await expect(withTimeout(Promise.resolve("fast"), 50, "too slow")).resolves.toBe("fast");
  });
});

describe("parseHostConcurrency()", () => {
  it("defaults to 8 and can be configured", () => {
    expect(parseHostConcurrency(undefined)).toBe(8);
    expect(parseHostConcurrency("")).toBe(8);
    expect(parseHostConcurrency("3")).toBe(3);
  });

  it.each(["0", "-1", "1.5", "abc"])("rejects %s", (value) => {
    expect(() => parseHostConcurrency(value)).toThrow("LINK_CHECK_HOST_CONCURRENCY");
  });
});

describe("checkLinks() per-host limit", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    setHostLimiter(new HostLimiter(3));
  });

  afterEach(() => {
    setHostLimiter(undefined);
    vi.restoreAllMocks();
  });

  it("never sends more than the per-host limit of concurrent requests to a host", async () => {
    const active: Record<string, number> = {};
    const max: Record<string, number> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const host = new URL(String(input)).hostname;
        active[host] = (active[host] ?? 0) + 1;
        max[host] = Math.max(max[host] ?? 0, active[host]);
        await sleep(5);
        active[host]--;
        return new Response(null, { status: 200 });
      }),
    );
    const { checkLinks } = await import("./link");
    const { withRun } = await import("./run");
    const links = [
      ...Array.from({ length: 30 }, (_, i) => `https://busy.example.com/page-${i}`),
      ...Array.from({ length: 5 }, (_, i) => `https://quiet.example.com/page-${i}`),
    ].map((href) => ({ href, page: "https://example.com", text: "" }));

    // checkLinks() starts its own run, so it needs the host concurrency in its config (not setHostLimiter())
    const results = await withRun({ hostConcurrency: 3 }, () => checkLinks({ links }));

    expect(results).toHaveLength(35);
    expect(results.every((r) => r.result.ok)).toBe(true);
    expect(max["busy.example.com"]).toBe(3);
    expect(max["quiet.example.com"]).toBe(3);
  });

  it("honours Retry-After on 429 and retries", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      return calls === 1
        ? new Response(null, { status: 429, headers: { "Retry-After": "0" } })
        : new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { checkLinkWithFetch } = await import("./fetch_check");

    expect(await checkLinkWithFetch("https://rate-limited.example.com/")).toEqual({
      ok: true,
      status: 200,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after a few 429 retries", async () => {
    const fetchMock = vi.fn(
      async () => new Response(null, { status: 429, headers: { "Retry-After": "0" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { checkLinkWithFetch } = await import("./fetch_check");

    expect(await checkLinkWithFetch("https://always-limited.example.com/")).toMatchObject({
      ok: false,
      error: "unexpected error",
      status: 429,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
