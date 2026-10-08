import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// TODO(effect): convert
import { getRunContext, withRun } from "../effect_compat";

const { octokit } = vi.hoisted(() => ({
  octokit: { repos: { get: vi.fn(), getContent: vi.fn() } },
}));

vi.mock("./github_client", () => ({ getMyOctokit: () => octokit }));

import { checkLinkWithGithubApi } from "./gh_check_link";

const delayed = <T>(value: T, ms = 10) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
const content = (markdown: string) => ({
  data: { type: "file", content: Buffer.from(markdown).toString("base64") },
});
const FILE_URL = "https://github.com/owner/repo/blob/main/README.md";
const REPO_URL = "https://github.com/owner/repo";

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
    await withRun({}, async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, () => checkLinkWithGithubApi(FILE_URL)),
      );
      expect(results.every((result) => result.ok)).toBe(true);
      // Later calls are cached too
      await checkLinkWithGithubApi(FILE_URL);
    });
    expect(octokit.repos.getContent).toHaveBeenCalledTimes(1);
  });

  it("caches different refs, paths and repositories separately", async () => {
    await withRun({}, async () => {
      await Promise.all([
        checkLinkWithGithubApi(FILE_URL),
        checkLinkWithGithubApi("https://github.com/owner/repo/blob/develop/README.md"),
        checkLinkWithGithubApi("https://github.com/owner/repo/blob/main/docs/README.md"),
        checkLinkWithGithubApi("https://github.com/owner/other/blob/main/README.md"),
      ]);
    });
    expect(octokit.repos.getContent).toHaveBeenCalledTimes(4);
  });

  it("caches repositories (case-insensitive)", async () => {
    await withRun({}, async () => {
      await Promise.all([
        checkLinkWithGithubApi(REPO_URL),
        checkLinkWithGithubApi("https://github.com/Owner/Repo"),
        checkLinkWithGithubApi(REPO_URL),
      ]);
    });
    expect(octokit.repos.get).toHaveBeenCalledTimes(1);
  });

  it("does not share the cache between runs", async () => {
    await withRun({}, () => checkLinkWithGithubApi(FILE_URL));
    await withRun({}, () => checkLinkWithGithubApi(FILE_URL));
    expect(octokit.repos.getContent).toHaveBeenCalledTimes(2);
  });

  it.each([404, 410])("caches %i (the repository is definitely missing)", async (status) => {
    octokit.repos.get.mockRejectedValue(Object.assign(new Error("Gone"), { status }));

    await withRun({}, async () => {
      for (let i = 0; i < 2; i++) {
        expect(await checkLinkWithGithubApi(REPO_URL)).toMatchObject({
          ok: false,
          error: "broken link",
          status,
        });
      }
    });
    expect(octokit.repos.get).toHaveBeenCalledTimes(1);
  });

  // Rate limits, bad token or no access, server errors: no proof the repository is missing, ask again next time
  it.each([502, 401, 403])("does not cache %i", async (status) => {
    octokit.repos.get.mockRejectedValue(Object.assign(new Error("Failed"), { status }));

    await withRun({}, async () => {
      for (let i = 0; i < 2; i++) {
        expect(await checkLinkWithGithubApi(REPO_URL)).toMatchObject({
          ok: false,
          error: "unexpected error",
          status,
        });
      }
    });
    expect(octokit.repos.get).toHaveBeenCalledTimes(2);
  });

  it("checks many hashes of the same file with one API request", async () => {
    const hashes = ["", "#title", "#usage", "#missing"];
    const results = await withRun({}, () =>
      Promise.all(hashes.map((hash) => checkLinkWithGithubApi(`${FILE_URL}${hash}`))),
    );

    expect(octokit.repos.getContent).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.ok)).toEqual([true, true, true, false]);
  });

  it("counts cache hits in the run metrics (requests are counted by the Octokit client)", async () => {
    await withRun({}, async () => {
      await Promise.all([
        checkLinkWithGithubApi(FILE_URL),
        checkLinkWithGithubApi(FILE_URL),
        checkLinkWithGithubApi(REPO_URL),
      ]);
      expect(getRunContext()!.metrics.counters).toMatchObject({ githubCacheHits: 1 });
    });
  });
});
