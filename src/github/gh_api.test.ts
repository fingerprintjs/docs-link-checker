import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Metrics } from "../run";
import { checkLinkWithGithubApi } from "./gh_check_link";
import { runWithFakeOctokit } from "./test_utils";

const octokit = { repos: { get: vi.fn(), getContent: vi.fn() } };

const delayed = <T>(value: T, ms = 10) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
const content = (markdown: string) => ({
  data: { type: "file", content: Buffer.from(markdown).toString("base64") },
});
const FILE_URL = "https://github.com/owner/repo/blob/main/README.md";
const REPO_URL = "https://github.com/owner/repo";

/** Checks the URLs in one run, at the same time (`concurrent`) or one after another */
const runChecks = (urls: string[], { concurrent = true } = {}) =>
  runWithFakeOctokit(
    Effect.gen(function* () {
      const results = yield* Effect.forEach(urls, checkLinkWithGithubApi, {
        concurrency: concurrent ? "unbounded" : 1,
      });
      const { counters } = yield* Effect.flatMap(Metrics, (metrics) => metrics.snapshot);
      return { results, counters };
    }),
    () => octokit,
  );

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  octokit.repos.get
    .mockReset()
    .mockImplementation(() => delayed({ data: { default_branch: "main" } }));
  octokit.repos.getContent
    .mockReset()
    .mockImplementation(() => delayed(content("# Title\n## Usage\n")));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GitHub API cache (through checkLinkWithGithubApi)", () => {
  it("dedupes concurrent checks of the same file within a run", async () => {
    const { results } = await runChecks(Array.from({ length: 10 }, () => FILE_URL));
    expect(results.every((result) => result.ok)).toBe(true);
    expect(octokit.repos.getContent).toHaveBeenCalledTimes(1);
  });

  it("caches later checks of the same file within a run", async () => {
    await runChecks([FILE_URL, FILE_URL], { concurrent: false });
    expect(octokit.repos.getContent).toHaveBeenCalledTimes(1);
  });

  it("caches different refs, paths and repositories separately", async () => {
    await runChecks([
      FILE_URL,
      "https://github.com/owner/repo/blob/develop/README.md",
      "https://github.com/owner/repo/blob/main/docs/README.md",
      "https://github.com/owner/other/blob/main/README.md",
    ]);
    expect(octokit.repos.getContent).toHaveBeenCalledTimes(4);
  });

  it("caches repositories (case-insensitive)", async () => {
    await runChecks([REPO_URL, "https://github.com/Owner/Repo", REPO_URL]);
    expect(octokit.repos.get).toHaveBeenCalledTimes(1);
  });

  it("does not share the cache between runs", async () => {
    await runChecks([FILE_URL]);
    await runChecks([FILE_URL]);
    expect(octokit.repos.getContent).toHaveBeenCalledTimes(2);
  });

  it.each([404, 410])("caches %i (the repository is definitely missing)", async (status) => {
    octokit.repos.get.mockRejectedValue(Object.assign(new Error("Gone"), { status }));

    const { results } = await runChecks([REPO_URL, REPO_URL], { concurrent: false });

    for (const result of results) {
      expect(result).toMatchObject({ ok: false, error: "broken link", status });
    }
    expect(octokit.repos.get).toHaveBeenCalledTimes(1);
  });

  // Rate limits, bad token or no access, server errors: no proof the repository is missing, ask again next time
  it.each([502, 401, 403])("does not cache %i", async (status) => {
    octokit.repos.get.mockRejectedValue(Object.assign(new Error("Failed"), { status }));

    const { results } = await runChecks([REPO_URL, REPO_URL], { concurrent: false });

    for (const result of results) {
      expect(result).toMatchObject({ ok: false, error: "unexpected error", status });
    }
    expect(octokit.repos.get).toHaveBeenCalledTimes(2);
  });

  it("checks many hashes of the same file with one API request", async () => {
    const hashes = ["", "#title", "#usage", "#missing"];
    const { results } = await runChecks(hashes.map((hash) => `${FILE_URL}${hash}`));

    expect(octokit.repos.getContent).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.ok)).toEqual([true, true, true, false]);
  });

  it("counts cache hits in the run metrics (requests are counted by the Octokit client)", async () => {
    const { counters } = await runChecks([FILE_URL, FILE_URL, REPO_URL]);
    expect(counters).toMatchObject({ githubCacheHits: 1 });
  });
});
