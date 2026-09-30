import { describe, it, expect, vi, beforeEach } from "vitest";
import { getMyOctokit, resetMyOctokit, throttleOptions } from "./github_client";

beforeEach(() => {
  resetMyOctokit();
});

describe("getMyOctokit()", () => {
  it("can be imported without GH_TOKEN, throws a clear error on first use", () => {
    vi.stubEnv("GH_TOKEN", "");
    expect(() => getMyOctokit()).toThrow("GH_TOKEN is not set");
  });

  it("creates the client lazily and reuses it", () => {
    vi.stubEnv("GH_TOKEN", "test-token");
    const client = getMyOctokit();
    expect(client).toBeDefined();
    expect(getMyOctokit()).toBe(client);
  });

  it("importing GitHub link checks does not require GH_TOKEN", async () => {
    vi.stubEnv("GH_TOKEN", "");
    vi.resetModules();
    await expect(import("./gh_check_link")).resolves.toBeDefined();
    await expect(import("./gh_get_links")).resolves.toBeDefined();
  });
});

describe("throttle options", () => {
  const fakeOctokit = { log: { warn: vi.fn(), info: vi.fn() } };
  const options = { method: "GET", url: "/repos/{owner}/{repo}" };

  it("onRateLimit retries once", () => {
    expect(throttleOptions.onRateLimit(10, options as never, fakeOctokit as never, 0)).toBe(true);
    expect(throttleOptions.onRateLimit(10, options as never, fakeOctokit as never, 1)).toBe(false);
  });

  it("onSecondaryRateLimit retries once", () => {
    expect(throttleOptions.onSecondaryRateLimit(10, options as never, fakeOctokit as never, 0)).toBe(true);
    expect(throttleOptions.onSecondaryRateLimit(10, options as never, fakeOctokit as never, 1)).toBe(false);
  });
});
