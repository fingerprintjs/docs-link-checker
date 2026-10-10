import { describe, expect, it, vi } from "vitest";

/** Fresh modules: the client is cached per module instance, `../run` must be the instance the client imports */
const loadModules = async () => {
  vi.resetModules();
  const [{ getMyOctokit }, { getRunContext, withRun }] = await Promise.all([
    import("./client"),
    import("../run"),
  ]);
  return { getMyOctokit, getRunContext, withRun };
};

describe("getMyOctokit()", () => {
  it("can be imported without GH_TOKEN, throws a clear error on first use", async () => {
    const { getMyOctokit } = await loadModules();
    vi.stubEnv("GH_TOKEN", "");
    expect(() => getMyOctokit()).toThrow("GH_TOKEN is not set");
  });

  it("importing GitHub link checks does not require GH_TOKEN", async () => {
    vi.stubEnv("GH_TOKEN", "");
    vi.resetModules();
    await expect(import("./check_link")).resolves.toBeDefined();
    await expect(import("./get_links")).resolves.toBeDefined();
  });
});

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("GitHub API request metrics", () => {
  it("counts every request sent by the shared client, whatever the operation", async () => {
    const { getMyOctokit, getRunContext, withRun } = await loadModules();
    vi.stubEnv("GH_TOKEN", "test-token");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/graphql")) return jsonResponse({ data: { viewer: { login: "me" } } });
      return jsonResponse({ id: 1 });
    });

    const counters = await withRun({ deps: { fetch: fetchMock } }, async () => {
      const octokit = getMyOctokit();
      await octokit.rest.repos.get({ owner: "o", repo: "r" });
      await octokit.rest.issues.get({ owner: "o", repo: "r", issue_number: 1 });
      await octokit.rest.pulls.get({ owner: "o", repo: "r", pull_number: 1 });
      await octokit.rest.repos.getReleaseByTag({ owner: "o", repo: "r", tag: "v1" });
      await octokit.graphql("query { viewer { login } }");
      return getRunContext()!.metrics.counters;
    });

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(counters.githubApiRequests).toBe(5);
  });
});
