import { beforeEach, describe, expect, it, vi } from "vitest";
import { withRun } from "../run";
import { checkLinkWithGithubApi as checkLink } from "./check_link";

// Fake Octokit: no network, records the parameters passed to every API call
const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });
const octokit = {
  notFound,
  // Simulates a missing `GH_TOKEN`: `getMyOctokit` throws
  noToken: false,
  users: { getByUsername: vi.fn() },
  repos: {
    get: vi.fn(),
    getReleaseByTag: vi.fn(),
    getContent: vi.fn(),
    getCommit: vi.fn(),
  },
  issues: { get: vi.fn() },
  pulls: { get: vi.fn() },
  git: { listMatchingRefs: vi.fn() },
  // All pages of a list endpoint: the fakes return a single page
  paginate: async (fn: (params: unknown) => Promise<{ data: unknown[] }>, params: unknown) =>
    (await fn(params)).data,
};

const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();

const checkLinkWithGithubApi = (url: string) =>
  withRun(
    {
      deps: {
        fetch: fetchMock,
        octokit: () => {
          if (octokit.noToken) {
            throw new Error(
              "GH_TOKEN is not set. A GitHub token is required to check GitHub links.",
            );
          }
          return octokit as never;
        },
      },
    },
    () => checkLink(url, new AbortController().signal),
  );

beforeEach(() => {
  octokit.noToken = false;
  for (const fn of [
    octokit.users.getByUsername,
    octokit.repos.get,
    octokit.repos.getReleaseByTag,
    octokit.repos.getContent,
    octokit.repos.getCommit,
    octokit.issues.get,
    octokit.pulls.get,
  ]) {
    fn.mockReset();
    fn.mockResolvedValue({ data: {} });
  }
  octokit.git.listMatchingRefs.mockReset();
  octokit.git.listMatchingRefs.mockResolvedValue({ data: [] });
});

describe("checkLinkWithGithubApi() with percent-encoded paths", () => {
  it("passes a decoded release tag to Octokit (which encodes it once)", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/vue/releases/tag/%40fingerprint%2Fvue%402.0.0",
    );

    expect(result).toEqual({ ok: true, status: 200 });
    expect(octokit.repos.getReleaseByTag).toHaveBeenCalledWith({
      owner: "fingerprintjs",
      repo: "vue",
      tag: "@fingerprint/vue@2.0.0",
      request: { signal: expect.any(AbortSignal) },
    });
  });

  it("accepts a release tag with an unencoded slash", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/vue/releases/tag/@fingerprint/vue@2.0.0",
    );

    expect(result).toEqual({ ok: true, status: 200 });
    expect(octokit.repos.getReleaseByTag).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "@fingerprint/vue@2.0.0" }),
    );
  });

  it("reports a missing (decoded) tag as broken link", async () => {
    octokit.repos.getReleaseByTag.mockRejectedValue(octokit.notFound());

    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/react-native/releases/tag/v4.0.0",
    );

    expect(result).toMatchObject({ ok: false, error: "broken link", status: 404 });
  });

  it("passes a decoded blob path and ref", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/o/r/blob/main/docs/my%20file%40v1.md",
    );

    expect(result).toEqual({ ok: true, status: 200 });
    expect(octokit.repos.getContent).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      ref: "main",
      path: "docs/my file@v1.md",
    });
  });

  it("passes a decoded tree path", async () => {
    const result = await checkLinkWithGithubApi("https://github.com/o/r/tree/v1.0/src/%5Bid%5D");

    expect(result).toEqual({ ok: true, status: 200 });
    expect(octokit.repos.getContent).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      ref: "v1.0",
      path: "src/[id]",
    });
  });

  it("passes a decoded commit ref", async () => {
    const result = await checkLinkWithGithubApi("https://github.com/o/r/commit/abc%31234");

    expect(result).toEqual({ ok: true, status: 200 });
    expect(octokit.repos.getCommit).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      ref: "abc1234",
      request: { signal: expect.any(AbortSignal) },
    });
  });

  it("does not throw on malformed percent-encoding", async () => {
    octokit.repos.getContent.mockRejectedValue(octokit.notFound());

    const result = await checkLinkWithGithubApi("https://github.com/o/r/blob/main/100%.md");

    expect(result).toMatchObject({ ok: false, error: "broken link", status: 404 });
    expect(octokit.repos.getContent).toHaveBeenCalledWith(
      expect.objectContaining({ path: "100%.md" }),
    );
  });
});

describe("checkLinkWithGithubApi() with user and organization URLs", () => {
  it.each([
    ["https://github.com/frida/", "frida"],
    ["https://github.com/Universal-Commerce-Protocol", "Universal-Commerce-Protocol"],
    ["https://github.com/ua-parser", "ua-parser"],
  ])("checks %s as an account, not as a repository", async (url, username) => {
    const result = await checkLinkWithGithubApi(url);

    expect(result).toEqual({ ok: true, status: 200 });
    expect(octokit.users.getByUsername).toHaveBeenCalledWith({
      username,
    });
    expect(octokit.repos.get).not.toHaveBeenCalled();
  });

  it("still checks repository URLs as repositories", async () => {
    const result = await checkLinkWithGithubApi("https://github.com/frida/frida/");

    expect(result).toEqual({ ok: true, status: 200 });
    expect(octokit.repos.get).toHaveBeenCalledWith({
      owner: "frida",
      repo: "frida",
    });
    expect(octokit.users.getByUsername).not.toHaveBeenCalled();
  });

  it("accepts github.com itself", async () => {
    expect(await checkLinkWithGithubApi("https://github.com/")).toEqual({ ok: true, status: 200 });
  });
});

describe("checkLinkWithGithubApi() with unknown sections", () => {
  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])(
    "reports /owner/repo/%s/x as an unknown link type (no inherited object property)",
    async (section) => {
      const result = await checkLinkWithGithubApi(`https://github.com/o/r/${section}/x`);
      expect(result).toEqual({
        ok: false,
        error: "unexpected error",
        status: 400,
        errorDetail: `Unknown link type: ${section}/x`,
      });
    },
  );
});

describe("checkLinkWithGithubApi() with unknown account URLs", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(
      async () => new Response("<html><body></body></html>", { status: 200 }),
    );
  });

  it("accepts an unknown account URL whose page exists (a GitHub page missing from the reserved routes)", async () => {
    octokit.users.getByUsername.mockRejectedValue(octokit.notFound());

    const result = await checkLinkWithGithubApi("https://github.com/premium-support");

    expect(result).toEqual({ ok: true, status: 200 });
    expect(octokit.users.getByUsername).toHaveBeenCalledWith({
      username: "premium-support",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([404, 429])(
    "reports the API 404 as broken link when the page of an unknown account answers %i",
    async (pageStatus) => {
      octokit.users.getByUsername.mockRejectedValue(octokit.notFound());
      fetchMock.mockImplementation(async () => new Response("No page", { status: pageStatus }));

      const result = await checkLinkWithGithubApi("https://github.com/no-such-org-xyz");

      expect(result).toEqual({
        ok: false,
        error: "broken link",
        status: 404,
        errorDetail: "User or organization no-such-org-xyz not found",
      });
    },
  );

  it("does not fetch the page of an existing account", async () => {
    await checkLinkWithGithubApi("https://github.com/fingerprintjs");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GitHub API errors", () => {
  const apiError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

  // 401 (bad token), 403 (rate limits after Octokit's retry, no access) and 5xx say nothing about the link
  it.each([401, 403, 502, 503])(
    "reports %i as unexpected error (not broken) for every link type",
    async (status) => {
      octokit.users.getByUsername.mockRejectedValue(apiError(status));
      octokit.repos.get.mockRejectedValue(apiError(status));
      octokit.repos.getContent.mockRejectedValue(apiError(status));
      octokit.repos.getReleaseByTag.mockRejectedValue(apiError(status));
      octokit.repos.getCommit.mockRejectedValue(apiError(status));
      octokit.issues.get.mockRejectedValue(apiError(status));
      octokit.pulls.get.mockRejectedValue(apiError(status));

      for (const url of [
        "https://github.com/someone",
        "https://github.com/o/r",
        "https://github.com/o/r/blob/main/a.ts",
        "https://github.com/o/r/blob/main/a.ts#L3",
        "https://github.com/o/r/tree/main",
        "https://github.com/o/r/tree/main/src",
        "https://github.com/o/r/releases/tag/v1.0.0",
        "https://github.com/o/r/releases/download/v1.0.0/a.zip",
        "https://github.com/o/r/commit/abc1234",
        "https://github.com/o/r/issues/1",
        "https://github.com/o/r/pull/1",
      ]) {
        // `unexpected error` is re-checked in the browser (see `shouldRecheckWithPlaywright`)
        expect({ url, result: await checkLinkWithGithubApi(url) }).toMatchObject({
          url,
          result: { ok: false, error: "unexpected error", status },
        });
      }
    },
  );

  it("reports a missing repository as broken link", async () => {
    octokit.repos.get.mockRejectedValue(octokit.notFound());

    const result = await checkLinkWithGithubApi("https://github.com/owner/missing-repo");

    expect(result).toMatchObject({ ok: false, error: "broken link", status: 404 });
  });

  it("reports a missing branch or commit as broken link", async () => {
    octokit.repos.getContent.mockRejectedValue(octokit.notFound());

    const result = await checkLinkWithGithubApi("https://github.com/o/r/tree/missing");

    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "No branch, tag or commit missing found in repository o/r",
    });
  });

  it("reports a deleted issue (410 Gone) as broken link", async () => {
    octokit.issues.get.mockRejectedValue(apiError(410));

    const result = await checkLinkWithGithubApi("https://github.com/o/r/issues/1");

    expect(result).toMatchObject({ ok: false, error: "broken link", status: 410 });
  });
});

describe("checkLinkWithGithubApi() with URL variants", () => {
  it.each([
    "https://github.com/o/r/issues",
    "https://github.com/o/r/issues/",
    "https://github.com/o/r/discussions",
    "https://github.com/o/r/releases",
    "https://github.com/o/r/pulls",
    "https://github.com/o/r?tab=readme-ov-file",
    "https://github.com/o/r/?tab=readme-ov-file",
  ])("checks %s as the repository", async (url) => {
    expect(await checkLinkWithGithubApi(url)).toEqual({ ok: true, status: 200 });
    expect(octokit.repos.get).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
    });
    expect(octokit.issues.get).not.toHaveBeenCalled();
    expect(octokit.repos.getContent).not.toHaveBeenCalled();
  });

  it("ignores the query string of a tree link", async () => {
    expect(await checkLinkWithGithubApi("https://github.com/o/r/tree/master?ref=main")).toEqual({
      ok: true,
      status: 200,
    });
    expect(octokit.repos.getContent).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      ref: "master",
      path: "",
    });
  });
});

describe("checkLinkWithGithubApi() with tree links", () => {
  it("resolves branch names with slashes, with or without a path", async () => {
    octokit.git.listMatchingRefs.mockImplementation(async ({ ref }: { ref: string }) => ({
      data: ref === "heads/feature" ? [{ ref: "refs/heads/feature/a/b/c/d" }] : [],
    }));
    octokit.repos.getContent.mockImplementation(async ({ ref }: { ref: string }) => {
      if (ref !== "feature/a/b/c/d") {
        throw octokit.notFound();
      }
      return { data: [] };
    });

    expect(await checkLinkWithGithubApi("https://github.com/o/r/tree/feature/a/b/c/d/src")).toEqual(
      { ok: true, status: 200 },
    );
    // The listing proves the branch exists
    expect(await checkLinkWithGithubApi("https://github.com/o/r/tree/feature/a/b/c/d")).toEqual({
      ok: true,
      status: 200,
    });
    expect(
      await checkLinkWithGithubApi("https://github.com/o/r/tree/feature/a/b/c/missing"),
    ).toMatchObject({ ok: false, error: "broken link", status: 404 });
  });
});

describe("checkLinkWithGithubApi() with code line links", () => {
  const fileContent = (text: string) => ({
    data: { type: "file", sha: "sha", content: Buffer.from(text).toString("base64") },
  });

  it("routes a code line link to the blob check (the file is read with the API)", async () => {
    octokit.repos.getContent.mockResolvedValue(fileContent("one\ntwo\n"));

    expect(await checkLinkWithGithubApi("https://github.com/o/r/blob/main/a.txt#L2")).toEqual({
      ok: true,
      status: 200,
    });
    expect(await checkLinkWithGithubApi("https://github.com/o/r/blob/main/a.txt#L3")).toMatchObject(
      { ok: false, error: "hash not found" },
    );
  });

  it("reports 'unexpected error' without a GH_TOKEN (checkLinks re-checks it in the browser)", async () => {
    octokit.noToken = true;

    const result = await checkLinkWithGithubApi("https://github.com/o/r/blob/main/a.ts#L3");

    expect(result).toMatchObject({
      ok: false,
      error: "unexpected error",
      errorDetail: expect.stringContaining("GH_TOKEN is not set"),
    });
  });
});
