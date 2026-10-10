import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostLimiter, parseHostConcurrency, parseRetryAfter, withTimeout } from "./limiter";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

  describe("pause", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** Simulated time until `promise` settles */
    const elapsed = async (promise: Promise<unknown>) => {
      const start = Date.now();
      const settled = promise.then(() => Date.now());
      await vi.advanceTimersByTimeAsync(1000);
      return (await settled) - start;
    };

    it("delays new requests to a paused host", async () => {
      const limiter = new HostLimiter(5);
      limiter.pause("https://paused.example.com/a", 50);

      expect(await elapsed(limiter.run("https://paused.example.com/b", async () => {}))).toBe(50);
      // Other hosts are not affected
      expect(await elapsed(limiter.run("https://other.example.com/", async () => {}))).toBe(0);
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
      await vi.advanceTimersByTimeAsync(0);
      limiter.pause("https://paused.example.com/a", 50);

      expect(await elapsed(limiter.waitUntilResumed("https://paused.example.com/b"))).toBe(50);
      expect(await elapsed(limiter.waitUntilResumed("https://other.example.com/"))).toBe(0);
      expect(await elapsed(limiter.waitUntilResumed("not a url"))).toBe(0);
      release();
      await busy;
    });
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
  it("rejects when the work takes too long", async () => {
    await expect(withTimeout(() => sleep(50), 5, "too slow")).rejects.toThrow("too slow");
    await expect(withTimeout(() => Promise.resolve("fast"), 50, "too slow")).resolves.toBe("fast");
  });

  it("aborts the signal of the work on timeout, not when the work is fast", async () => {
    let slowSignal: AbortSignal | undefined;
    await expect(
      withTimeout(
        (signal) => {
          slowSignal = signal;
          return sleep(50);
        },
        5,
        "too slow",
      ),
    ).rejects.toThrow("too slow");
    expect(slowSignal?.aborted).toBe(true);
    expect(slowSignal?.reason).toEqual(new Error("too slow"));

    let fastSignal: AbortSignal | undefined;
    await withTimeout(
      async (signal) => {
        fastSignal = signal;
      },
      20,
      "too slow",
    );
    await sleep(40);
    expect(fastSignal?.aborted).toBe(false);
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
