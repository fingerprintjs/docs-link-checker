import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { octokit } = vi.hoisted(() => ({
  octokit: { repos: { get: vi.fn(), getContent: vi.fn() } },
}));

vi.mock("./github_client", () => ({ getMyOctokit: () => octokit }));

import { getRunContext, withRun } from "../run";
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

  it("does not cache outside of a run", async () => {
    await checkLinkWithGithubApi(FILE_URL);
    await checkLinkWithGithubApi(FILE_URL);
    expect(octokit.repos.getContent).toHaveBeenCalledTimes(2);
  });

  it("does not share the cache between runs", async () => {
    await withRun({}, () => checkLinkWithGithubApi(FILE_URL));
    await withRun({}, () => checkLinkWithGithubApi(FILE_URL));
    expect(octokit.repos.getContent).toHaveBeenCalledTimes(2);
  });

  it("caches 404s but retries other errors", async () => {
    octokit.repos.get.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
    octokit.repos.getContent.mockRejectedValue(
      Object.assign(new Error("Server Error"), { status: 502 }),
    );

    await withRun({}, async () => {
      for (let i = 0; i < 2; i++) {
        expect(await checkLinkWithGithubApi("https://github.com/owner/gone")).toMatchObject({
          ok: false,
          status: 404,
        });
        expect(await checkLinkWithGithubApi(FILE_URL)).toMatchObject({
          ok: false,
          error: "unexpected error",
          status: 502,
        });
      }
    });
    expect(octokit.repos.get).toHaveBeenCalledTimes(1);
    expect(octokit.repos.getContent).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403])(
    "does not cache %i (bad token, rate limit or no access), it is no proof the repository is missing",
    async (status) => {
      octokit.repos.get.mockRejectedValue(Object.assign(new Error("Denied"), { status }));

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
    },
  );

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
