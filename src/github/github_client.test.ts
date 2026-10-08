import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { Metrics } from "../run";
import { GitHubClient, githubRequest } from "./github_client";

const run = <A, E>(effect: Effect.Effect<A, E, GitHubClient | Metrics>) =>
  Effect.runPromise(effect.pipe(Effect.provide(GitHubClient.layer), Effect.provide(Metrics.layer)));

describe("GitHubClient", () => {
  it("can be built without GH_TOKEN, a request fails with a clear error", async () => {
    vi.stubEnv("GH_TOKEN", "");
    const error = await run(
      Effect.flip(githubRequest((octokit) => octokit.rest.repos.get({ owner: "o", repo: "r" }))),
    );
    expect(error).toMatchObject({ _tag: "GitHubApiError", status: undefined });
    expect(error.message).toContain("GH_TOKEN is not set");
  });

  it("importing GitHub link checks does not require GH_TOKEN", async () => {
    vi.stubEnv("GH_TOKEN", "");
    vi.resetModules();
    await expect(import("./gh_check_link")).resolves.toBeDefined();
    await expect(import("./gh_get_links")).resolves.toBeDefined();
  });

  it("keeps the HTTP status of a failed request", async () => {
    vi.stubEnv("GH_TOKEN", "test-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })),
    );
    const error = await run(
      Effect.flip(githubRequest((octokit) => octokit.rest.repos.get({ owner: "o", repo: "r" }))),
    );
    expect(error.status).toBe(404);
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
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/graphql")) return jsonResponse({ data: { viewer: { login: "me" } } });
      return jsonResponse({ id: 1 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const counters = await run(
      Effect.gen(function* () {
        yield* githubRequest(async (octokit) => {
          await octokit.rest.repos.get({ owner: "o", repo: "r" });
          await octokit.rest.issues.get({ owner: "o", repo: "r", issue_number: 1 });
          await octokit.rest.pulls.get({ owner: "o", repo: "r", pull_number: 1 });
          await octokit.rest.repos.getReleaseByTag({ owner: "o", repo: "r", tag: "v1" });
          await octokit.graphql("query { viewer { login } }");
        });
        return (yield* (yield* Metrics).snapshot).counters;
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(counters.githubApiRequests).toBe(5);
  });
});
