import { beforeEach, describe, expect, it, vi } from "vitest";
import { withRun } from "../run";
import { getRunContext } from "../run_context";
import {
  checkGitHubRateLimit,
  getMyOctokit,
  resetMyOctokit,
  throttleOptions,
} from "./github_client";

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
    expect(
      throttleOptions.onSecondaryRateLimit(10, options as never, fakeOctokit as never, 0),
    ).toBe(true);
    expect(
      throttleOptions.onSecondaryRateLimit(10, options as never, fakeOctokit as never, 1),
    ).toBe(false);
  });
});

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("GitHub API request metrics", () => {
  it("counts every request sent by the shared client, whatever the operation", async () => {
    vi.stubEnv("GH_TOKEN", "test-token");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "table").mockImplementation(() => {});
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/graphql")) return jsonResponse({ data: { viewer: { login: "me" } } });
      if (url.includes("/rate_limit")) return jsonResponse({ rate: { remaining: 5000, reset: 0 } });
      return jsonResponse({ id: 1 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const counters = await withRun(async () => {
      const octokit = getMyOctokit();
      await octokit.rest.repos.get({ owner: "o", repo: "r" });
      await octokit.rest.issues.get({ owner: "o", repo: "r", issue_number: 1 });
      await octokit.rest.pulls.get({ owner: "o", repo: "r", pull_number: 1 });
      await octokit.rest.repos.getReleaseByTag({ owner: "o", repo: "r", tag: "v1" });
      await octokit.graphql("query { viewer { login } }");
      await checkGitHubRateLimit(octokit);
      return getRunContext()!.metrics.counters;
    });

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(counters.githubApiRequests).toBe(6);
  });

  it("does not count (or fail) outside of a run", async () => {
    vi.stubEnv("GH_TOKEN", "test-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ id: 1 })),
    );
    await expect(getMyOctokit().rest.repos.get({ owner: "o", repo: "r" })).resolves.toBeDefined();
  });
});
