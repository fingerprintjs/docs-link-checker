import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { octokit } = vi.hoisted(() => ({
  octokit: { repos: { get: vi.fn(), getContent: vi.fn() } },
}));

vi.mock("./github_client", () => ({ getMyOctokit: () => octokit }));

import { getRunContext, withRun } from "../run";
import { checkGitHubBlobLink } from "./checks/gh_blob";
import { checkIfRepositoryExists } from "./checks/gh_repo";
import { getContentCached, getRepoCached } from "./gh_cache";

const delayed = <T>(value: T, ms = 10) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
const content = (markdown: string) => ({
  data: { type: "file", content: Buffer.from(markdown).toString("base64") },
});
const params = { owner: "owner", repo: "repo", ref: "main", path: "README.md" };

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

describe("GitHub API cache", () => {
  it("dedupes concurrent calls for the same (owner, repo, ref, path) within a run", async () => {
    await withRun({}, async () => {
      const responses = await Promise.all(
        Array.from({ length: 10 }, () => getContentCached(params)),
      );
      expect(new Set(responses).size).toBe(1);
      // Later calls are cached too
      await getContentCached(params);
    });
    expect(octokit.repos.getContent).toHaveBeenCalledTimes(1);
  });

  it("caches different refs and paths separately", async () => {
    await withRun({}, async () => {
      await Promise.all([
        getContentCached(params),
        getContentCached({ ...params, ref: "develop" }),
        getContentCached({ ...params, path: "docs/README.md" }),
        getContentCached({ ...params, repo: "other" }),
      ]);
    });
    expect(octokit.repos.getContent).toHaveBeenCalledTimes(4);
  });

  it("caches repositories (case-insensitive)", async () => {
    await withRun({}, async () => {
      await Promise.all([
        getRepoCached("owner", "repo"),
        getRepoCached("Owner", "Repo"),
        getRepoCached("owner", "repo"),
      ]);
    });
    expect(octokit.repos.get).toHaveBeenCalledTimes(1);
  });

  it("does not cache outside of a run", async () => {
    await getContentCached(params);
    await getContentCached(params);
    expect(octokit.repos.getContent).toHaveBeenCalledTimes(2);
  });

  it("does not share the cache between runs", async () => {
    await withRun({}, () => getContentCached(params));
    await withRun({}, () => getContentCached(params));
    expect(octokit.repos.getContent).toHaveBeenCalledTimes(2);
  });

  it("caches 404s but retries other errors", async () => {
    octokit.repos.get.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
    octokit.repos.getContent.mockRejectedValue(
      Object.assign(new Error("Server Error"), { status: 502 }),
    );

    await withRun({}, async () => {
      expect(await checkIfRepositoryExists("owner", "gone")).toMatchObject({
        ok: false,
        status: 404,
      });
      expect(await checkIfRepositoryExists("owner", "gone")).toMatchObject({
        ok: false,
        status: 404,
      });

      await expect(getContentCached(params)).rejects.toThrow("Server Error");
      await expect(getContentCached(params)).rejects.toThrow("Server Error");
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
          expect(await checkIfRepositoryExists("owner", "repo")).toMatchObject({
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
      Promise.all(
        hashes.map((hash) =>
          checkGitHubBlobLink(
            new URL(`https://github.com/owner/repo/blob/main/README.md${hash}`),
            "owner",
            "repo",
            ["blob", "main", "README.md"],
          ),
        ),
      ),
    );

    expect(octokit.repos.getContent).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.ok)).toEqual([true, true, true, false]);
  });

  it("counts cache hits in the run metrics (requests are counted by the Octokit client)", async () => {
    await withRun({}, async () => {
      await Promise.all([
        getContentCached(params),
        getContentCached(params),
        getRepoCached("owner", "repo"),
      ]);
      expect(getRunContext()!.metrics.counters).toMatchObject({ githubCacheHits: 1 });
    });
  });
});
