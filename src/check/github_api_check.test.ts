import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerAfter,
  apiError,
  createFakeGithubApi,
  directoryContent,
  type FakeGithubApi,
  fileContent,
  graphqlError,
  largeFileContent,
  notFound,
} from "../github/fake_github_api";
import { getRunContext, withRun } from "../run";
import { withTimeout } from "../utils/limiter";
import { checkLinkWithGithubApi } from "./github_api_check";

let api: FakeGithubApi;
// Simulates a missing `GH_TOKEN`: the client can't be created
let noToken: boolean;
const pageFetch = vi.fn<typeof fetch>();

/** Runs `fn` as a run with the fake GitHub API (and `fetch` for the pages of unknown accounts) */
const run = <T>(fn: () => Promise<T>) =>
  withRun(
    {
      deps: {
        fetch: pageFetch,
        octokit: () => {
          if (noToken) {
            throw new Error(
              "GH_TOKEN is not set. A GitHub token is required to check GitHub links.",
            );
          }
          return api;
        },
      },
    },
    fn,
  );

const check = (url: string, signal = new AbortController().signal) =>
  checkLinkWithGithubApi(url, signal);

/** Checks `url` in its own run */
const checkInRun = (url: string) => run(() => check(url));

const withSignal = { request: { signal: expect.any(AbortSignal) } };
const OK = { ok: true, status: 200 };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  api = createFakeGithubApi();
  noToken = false;
  pageFetch.mockReset().mockResolvedValue(new Response("<html></html>", { status: 200 }));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("checkLinkWithGithubApi() link types", () => {
  it.each<[string, () => unknown, object]>([
    [
      "https://github.com/fingerprintjs",
      () => api.users.getByUsername,
      { username: "fingerprintjs" },
    ],
    ["https://github.com/frida/", () => api.users.getByUsername, { username: "frida" }],
    ["https://github.com/frida/frida/", () => api.repos.get, { owner: "frida", repo: "frida" }],
    ["https://github.com/o/r/issues/12", () => api.issues.get, { issue_number: 12 }],
    ["https://github.com/o/r/pull/34", () => api.pulls.get, { pull_number: 34 }],
    ["https://github.com/o/r/pull/34/files", () => api.pulls.get, { pull_number: 34 }],
    ["https://github.com/o/r/commit/abc%31234", () => api.repos.getCommit, { ref: "abc1234" }],
    ["https://github.com/o/r/releases/123", () => api.repos.getRelease, { release_id: 123 }],
    [
      "https://github.com/fingerprintjs/vue/releases/tag/%40fingerprint%2Fvue%402.0.0",
      () => api.repos.getReleaseByTag,
      { owner: "fingerprintjs", repo: "vue", tag: "@fingerprint/vue@2.0.0" },
    ],
    [
      "https://github.com/fingerprintjs/vue/releases/tag/@fingerprint/vue@2.0.0",
      () => api.repos.getReleaseByTag,
      { tag: "@fingerprint/vue@2.0.0" },
    ],
    [
      "https://github.com/o/r/releases/latest",
      () => api.repos.getLatestRelease,
      { owner: "o", repo: "r" },
    ],
    [
      "https://github.com/o/r/blob/main/docs/my%20file%40v1.md",
      () => api.repos.getContent,
      { owner: "o", repo: "r", ref: "main", path: "docs/my file@v1.md" },
    ],
    ["https://github.com/o/r/blob/main/100%.md", () => api.repos.getContent, { path: "100%.md" }],
    [
      "https://github.com/o/r/tree/v1.0/src/%5Bid%5D",
      () => api.repos.getContent,
      { ref: "v1.0", path: "src/[id]" },
    ],
    [
      "https://github.com/o/r/tree/master?ref=main",
      () => api.repos.getContent,
      { ref: "master", path: "" },
    ],
  ])("checks %s with the decoded URL parts", async (url, method, params) => {
    expect(await checkInRun(url)).toEqual(OK);
    expect(method()).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ ...params, ...withSignal }),
    );
  });

  it("accepts the latest release without listing releases, the list can come back empty", async () => {
    api.repos.listReleases.mockResolvedValue({ data: [] });
    expect(await checkInRun("https://github.com/o/r/releases/latest")).toEqual(OK);
    expect(api.repos.listReleases).not.toHaveBeenCalled();
  });

  it("accepts the latest release of a repository with only prereleases", async () => {
    api.repos.getLatestRelease.mockRejectedValue(notFound());
    expect(await checkInRun("https://github.com/o/r/releases/latest")).toEqual(OK);
    expect(api.repos.listReleases).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ owner: "o", repo: "r", per_page: 1 }),
    );
  });

  it("checks a discussion with GraphQL", async () => {
    expect(await checkInRun("https://github.com/o/r/discussions/9")).toEqual(OK);
    expect(api.graphql).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("discussion"), {
      owner: "o",
      repo: "r",
      number: 9,
      ...withSignal,
    });
  });

  it.each([
    "https://github.com/o/r",
    "https://github.com/o/r/issues",
    "https://github.com/o/r/issues/",
    "https://github.com/o/r/discussions",
    "https://github.com/o/r/releases",
    "https://github.com/o/r/pulls",
    "https://github.com/o/r?tab=readme-ov-file",
    "https://github.com/o/r/?tab=readme-ov-file",
  ])("checks %s as the repository", async (url) => {
    expect(await checkInRun(url)).toEqual(OK);
    expect(api.repos.get).toHaveBeenCalledExactlyOnceWith({ owner: "o", repo: "r", ...withSignal });
    expect(api.users.getByUsername).not.toHaveBeenCalled();
    expect(api.issues.get).not.toHaveBeenCalled();
  });

  it.each(["https://github.com/", "https://github.com/o/r/issues/new"])(
    "accepts %s without a request",
    async (url) => {
      noToken = true;
      expect(await checkInRun(url)).toEqual(OK);
    },
  );

  it("accepts a release asset", async () => {
    api.repos.getReleaseByTag.mockResolvedValue({ data: { assets: [{ name: "a.zip" }] } });

    expect(await checkInRun("https://github.com/o/r/releases/download/v1/a.zip")).toEqual(OK);
    expect(api.repos.getReleaseByTag).toHaveBeenCalledWith(expect.objectContaining({ tag: "v1" }));
  });
});

describe("checkLinkWithGithubApi() missing resources", () => {
  it.each<[string, () => void, object]>([
    [
      "https://github.com/owner/missing-repo",
      () => api.repos.get.mockRejectedValue(notFound()),
      { status: 404, errorDetail: "Repository owner/missing-repo not found" },
    ],
    [
      "https://github.com/o/r/issues/1",
      () => api.issues.get.mockRejectedValue(notFound()),
      { status: 404, errorDetail: "Issue #1 not found in repository o/r" },
    ],
    // Deleted issue
    [
      "https://github.com/o/r/issues/1",
      () => api.issues.get.mockRejectedValue(apiError(410)),
      { status: 410 },
    ],
    [
      "https://github.com/o/r/pull/7",
      () => api.pulls.get.mockRejectedValue(notFound()),
      { status: 404, errorDetail: "Pull request #7 not found in repository o/r" },
    ],
    [
      "https://github.com/o/r/commit/abc",
      () => api.repos.getCommit.mockRejectedValue(notFound()),
      { status: 404, errorDetail: "Commit not found" },
    ],
    // Unknown SHA: GitHub answers 422 "No commit found for SHA"
    [
      "https://github.com/o/r/commit/abc",
      () => api.repos.getCommit.mockRejectedValue(apiError(422)),
      { status: 422, errorDetail: "Commit not found" },
    ],
    [
      "https://github.com/o/r/discussions/9",
      () =>
        api.graphql.mockRejectedValue(
          graphqlError("Could not resolve to a Discussion with the number of 9.", "NOT_FOUND"),
        ),
      { status: 404, errorDetail: "Discussion #9 not found in repository o/r" },
    ],
    [
      "https://github.com/o/r/discussions/9",
      () => api.graphql.mockRejectedValue(graphqlError("Something else", "NOT_FOUND")),
      { status: 404 },
    ],
    [
      "https://github.com/o/r/discussions/9",
      () =>
        api.graphql.mockRejectedValue(
          new Error("Could not resolve to a Repository with the name 'o/r'."),
        ),
      { status: 404 },
    ],
    [
      "https://github.com/o/r/releases/123",
      () => api.repos.getRelease.mockRejectedValue(notFound()),
      { status: 404, errorDetail: "Release #123 not found in repository o/r" },
    ],
    [
      "https://github.com/o/r/releases/tag/v4.0.0",
      () => api.repos.getReleaseByTag.mockRejectedValue(notFound()),
      { status: 404, errorDetail: "Release tag v4.0.0 not found in repository o/r" },
    ],
    [
      "https://github.com/o/r/releases/download/v1/b.zip",
      () => api.repos.getReleaseByTag.mockResolvedValue({ data: { assets: [{ name: "a.zip" }] } }),
      { status: 404, errorDetail: "Asset b.zip not found in release v1 of repository o/r" },
    ],
    [
      "https://github.com/o/r/releases/download/v1/a.zip",
      () => api.repos.getReleaseByTag.mockRejectedValue(notFound()),
      { status: 404, errorDetail: "Release tag v1 not found in repository o/r" },
    ],
    [
      "https://github.com/o/r/releases/latest",
      () => {
        api.repos.getLatestRelease.mockRejectedValue(notFound());
        api.repos.listReleases.mockResolvedValue({ data: [] });
      },
      { status: 404, errorDetail: "No releases found in repository" },
    ],
    [
      "https://github.com/o/r/releases/latest",
      () => {
        api.repos.getLatestRelease.mockRejectedValue(notFound());
        api.repos.listReleases.mockRejectedValue(notFound());
      },
      { status: 404, errorDetail: "Repository o/r not found" },
    ],
    [
      "https://github.com/o/r/blob/main/missing.md",
      () => api.repos.getContent.mockRejectedValue(notFound()),
      { status: 404, errorDetail: "File not found in repository" },
    ],
    [
      "https://github.com/o/r/tree/missing",
      () => api.repos.getContent.mockRejectedValue(notFound()),
      { status: 404, errorDetail: "No branch, tag or commit missing found in repository o/r" },
    ],
    [
      "https://github.com/o/r/tree/v1/missing",
      () => api.repos.getContent.mockRejectedValue(notFound()),
      { status: 404, errorDetail: "Path missing not found in branch, tag or commit v1" },
    ],
  ])("reports %s as broken link", async (url, arrange, expected) => {
    arrange();
    expect(await checkInRun(url)).toMatchObject({ ok: false, error: "broken link", ...expected });
  });

  it.each([
    ["https://github.com/o/r/issues/abc", { errorDetail: "Invalid issue number format: abc" }],
    [
      "https://github.com/o/r/pull/abc",
      { status: 404, errorDetail: "Invalid pull request number" },
    ],
    [
      "https://github.com/o/r/releases/x",
      { status: 404, errorDetail: "Invalid release URL format" },
    ],
    // The whole segment must be a positive integer, not just start with one
    ["https://github.com/o/r/issues/12abc", { errorDetail: "Invalid issue number format: 12abc" }],
    ["https://github.com/o/r/issues/0", { errorDetail: "Invalid issue number format: 0" }],
    [
      "https://github.com/o/r/pull/34abc",
      { status: 404, errorDetail: "Invalid pull request number" },
    ],
    [
      "https://github.com/o/r/pull/99999999999999999999",
      { status: 404, errorDetail: "Invalid pull request number" },
    ],
    [
      "https://github.com/o/r/releases/123abc",
      { status: 404, errorDetail: "Invalid release URL format" },
    ],
  ])("reports %s as broken link without a request", async (url, expected) => {
    noToken = true;
    expect(await checkInRun(url)).toEqual({ ok: false, error: "broken link", ...expected });
  });

  it.each([
    "constructor/x",
    "toString/x",
    "__proto__/x",
    "wat",
    "discussions/categories/news",
    "discussions/9abc",
  ])("reports /o/r/%s as an unknown link type (re-checked in the browser)", async (path) => {
    noToken = true;
    expect(await checkInRun(`https://github.com/o/r/${path}`)).toEqual({
      ok: false,
      error: "unexpected error",
      status: 400,
      errorDetail: `Unknown link type: ${path}`,
    });
  });
});

describe("checkLinkWithGithubApi() unknown accounts", () => {
  beforeEach(() => {
    api.users.getByUsername.mockRejectedValue(notFound());
  });

  it("accepts an unknown account whose page exists (a GitHub page missing from the reserved routes)", async () => {
    expect(await checkInRun("https://github.com/premium-support")).toEqual(OK);
    expect(pageFetch).toHaveBeenCalledTimes(1);
  });

  it.each([404, 429])("reports the API 404 when the page answers %i", async (pageStatus) => {
    pageFetch.mockResolvedValue(new Response("No page", { status: pageStatus }));

    expect(await checkInRun("https://github.com/no-such-org-xyz")).toEqual({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "User or organization no-such-org-xyz not found",
    });
  });

  it("does not fetch the page of an existing account", async () => {
    api.users.getByUsername.mockResolvedValue({ data: {} });
    await checkInRun("https://github.com/fingerprintjs");
    expect(pageFetch).not.toHaveBeenCalled();
  });
});

/** One URL per link type that sends a request */
const URL_PER_LINK_TYPE = [
  "https://github.com/someone",
  "https://github.com/o/r",
  "https://github.com/o/r/blob/main/a.ts",
  "https://github.com/o/r/blob/main/a.ts#L3",
  "https://github.com/o/r/tree/main",
  "https://github.com/o/r/tree/main/src",
  "https://github.com/o/r/releases/123",
  "https://github.com/o/r/releases/tag/v1.0.0",
  "https://github.com/o/r/releases/download/v1.0.0/a.zip",
  "https://github.com/o/r/releases/latest",
  "https://github.com/o/r/commit/abc1234",
  "https://github.com/o/r/issues/1",
  "https://github.com/o/r/pull/1",
  "https://github.com/o/r/discussions/1",
];

const failEveryRequest = (error: Error) => {
  for (const method of [
    api.users.getByUsername,
    api.repos.get,
    api.repos.getContent,
    api.repos.getCommit,
    api.repos.getRelease,
    api.repos.getReleaseByTag,
    api.repos.getLatestRelease,
    api.repos.listReleases,
    api.issues.get,
    api.pulls.get,
    api.graphql,
  ]) {
    method.mockRejectedValue(error);
  }
};

describe("checkLinkWithGithubApi() API errors", () => {
  // 401 (bad token), 403 (rate limits after Octokit's retry, no access), 429 and 5xx say nothing about the link
  it.each([401, 403, 429, 502, 503])(
    "reports %i as unexpected error (re-checked in the browser) for every link type",
    async (status) => {
      failEveryRequest(apiError(status));
      for (const url of URL_PER_LINK_TYPE) {
        expect({ url, result: await checkInRun(url) }).toMatchObject({
          url,
          result: { ok: false, error: "unexpected error", status },
        });
      }
    },
  );

  it("reports a network error as unexpected error without a status", async () => {
    failEveryRequest(apiError(undefined, "fetch failed"));
    for (const url of URL_PER_LINK_TYPE) {
      const result = await checkInRun(url);
      expect({ url, result }).toMatchObject({
        url,
        result: { ok: false, error: "unexpected error" },
      });
      expect(result).not.toHaveProperty("status");
    }
  });

  it("reports a GraphQL error that is not NOT_FOUND as unexpected error", async () => {
    api.graphql.mockRejectedValue(graphqlError("Something went wrong", "INTERNAL"));
    expect(await checkInRun("https://github.com/o/r/discussions/1")).toMatchObject({
      ok: false,
      error: "unexpected error",
    });
  });

  it("reports 'unexpected error' without a GH_TOKEN for every link type", async () => {
    noToken = true;
    for (const url of URL_PER_LINK_TYPE) {
      expect({ url, result: await checkInRun(url) }).toMatchObject({
        url,
        result: {
          ok: false,
          error: "unexpected error",
          errorDetail: expect.stringContaining("GH_TOKEN is not set"),
        },
      });
    }
  });
});

describe("checkLinkWithGithubApi() blob hashes", () => {
  const readme = readFileSync(join(import.meta.dirname, "..", "__fixtures__", "readme.md"), "utf8");
  const blob = (refPathAndHash: string) =>
    checkInRun(`https://github.com/owner/repo/blob/${refPathAndHash}`);

  describe("headings", () => {
    beforeEach(() => {
      api.repos.getContent.mockResolvedValue(fileContent(readme));
    });

    it.each(["", "#installation", "#InStAlLaTiOn"])("accepts %s", async (hash) => {
      expect(await blob(`main/README.md${hash}`)).toEqual(OK);
    });

    it("reports a code block comment as 'hash not found'", async () => {
      expect(await blob("main/README.md#Not-A-Heading")).toEqual({
        ok: false,
        error: "hash not found",
        status: 200,
        errorDetail: "No heading found matching hash: not-a-heading",
      });
    });

    it("decodes percent-encoded hashes", async () => {
      api.repos.getContent.mockResolvedValue(fileContent("## Café\n"));
      expect(await blob("main/README.md#caf%C3%A9")).toEqual(OK);
    });
  });

  it("accepts a directory without a hash, reports a directory with a hash as 'hash not found'", async () => {
    api.repos.getContent.mockResolvedValue(directoryContent());

    expect(await blob("main/src")).toEqual(OK);
    expect(await blob("main/src#L1")).toEqual({
      ok: false,
      error: "hash not found",
      status: 200,
      errorDetail: "File has no content",
    });
  });

  describe("code lines", () => {
    beforeEach(() => {
      // 3 lines, the trailing newline does not start a 4th one
      api.repos.getContent.mockResolvedValue(fileContent("one\ntwo\nthree\n"));
    });

    // Anchor grammar is covered by line_anchor.test.ts, here: line counting and percent-decoding
    it.each(["#L3", "#%4C2", "#L1-L3", "#L1C2-L3C1"])(
      "accepts %s within the file",
      async (hash) => {
        expect(await blob(`main/src/a.ts${hash}`)).toEqual(OK);
      },
    );

    it.each(["#L4", "#L2-L4"])(
      "reports %s past the end of the file as 'hash not found'",
      async (hash) => {
        expect(await blob(`main/src/a.ts${hash}`)).toEqual({
          ok: false,
          error: "hash not found",
          status: 200,
          errorDetail: "src/a.ts has only 3 lines",
        });
      },
    );

    it("reports an invalid line anchor as 'hash not found'", async () => {
      expect(await blob("main/src/a.ts#L0")).toMatchObject({
        error: "hash not found",
        errorDetail: expect.stringContaining("Invalid line anchor"),
      });
    });

    it("treats a lowercase `#l2` as a heading, not a line", async () => {
      expect(await blob("main/src/a.ts#l2")).toMatchObject({
        error: "hash not found",
        errorDetail: "No heading found matching hash: l2",
      });
    });

    it("reports line anchors on binary files as 'hash not found'", async () => {
      api.repos.getContent.mockResolvedValue(
        fileContent(Buffer.from([0x89, 0x50, 0x00, 0x0a, 0x01])),
      );

      expect(await blob("main/logo.png#L1")).toMatchObject({
        error: "hash not found",
        errorDetail: "logo.png (binary file) has only 0 lines",
      });
    });

    it("checks rendered markdown against the lines, a heading `L12` matches too, not with `?plain=1`", async () => {
      api.repos.getContent.mockResolvedValue(fileContent("# Title\n\n## L12\n"));

      expect(await blob("main/README.md#L3")).toEqual(OK);
      expect(await blob("main/README.md#L12")).toEqual(OK);
      expect(await blob("main/README.md#L13")).toMatchObject({ error: "hash not found" });
      expect(await blob("main/README.md?plain=1#L12")).toMatchObject({
        error: "hash not found",
        errorDetail: "README.md has only 3 lines",
      });
    });
  });

  describe("files over 1 MB", () => {
    const big = "x\n".repeat(200_000);

    beforeEach(() => {
      api.repos.getContent.mockResolvedValue(largeFileContent(big.length));
      api.git.getBlob.mockResolvedValue({ data: { content: Buffer.from(big).toString("base64") } });
    });

    it("reads them with the blob API, once for all hashes", async () => {
      await run(async () => {
        expect(await check("https://github.com/owner/repo/blob/main/big.txt")).toEqual(OK);
        expect(await check("https://github.com/owner/repo/blob/main/big.txt#L200000")).toEqual(OK);
        expect(
          await check("https://github.com/owner/repo/blob/main/big.txt#L200001"),
        ).toMatchObject({
          error: "hash not found",
          errorDetail: "big.txt has only 200000 lines",
        });
      });
      expect(api.git.getBlob).toHaveBeenCalledExactlyOnceWith({
        owner: "owner",
        repo: "repo",
        file_sha: "bigsha",
        ...withSignal,
      });
    });

    it("reports a failing blob request as 'unexpected error'", async () => {
      api.git.getBlob.mockRejectedValue(apiError(502));
      expect(await blob("main/big.txt#L1")).toMatchObject({
        ok: false,
        error: "unexpected error",
        status: 502,
      });
    });
  });
});

describe("checkLinkWithGithubApi() refs with slashes", () => {
  /** Branches and tags of the repository (`heads/feature/x`, `tags/v1`) */
  const mockRefs = (refs: string[]) => {
    api.git.listMatchingRefs.mockImplementation(async ({ ref }) => ({
      // Prefix match like the API: `heads/feature` matches `heads/feature-2` too
      data: refs.filter((name) => name.startsWith(ref)).map((name) => ({ ref: `refs/${name}` })),
    }));
  };
  /** The repository has only `filePath` at `fileRef` */
  const mockFileAt = (fileRef: string, filePath: string, text: string) => {
    api.repos.getContent.mockImplementation(async ({ ref, path }) => {
      if (ref !== fileRef || path !== filePath) {
        throw notFound();
      }
      return fileContent(text);
    });
  };
  const blob = (refPathAndHash: string) =>
    checkInRun(`https://github.com/o/r/blob/${refPathAndHash}`);
  const tree = (refAndPath: string) => checkInRun(`https://github.com/o/r/tree/${refAndPath}`);

  it("resolves branch names with slashes (`feature/x`)", async () => {
    mockRefs(["heads/feature", "heads/feature-2", "heads/feature/x"]);
    mockFileAt("feature/x", "src/a.ts", "a\nb\n");

    expect(await blob("feature/x/src/a.ts#L2")).toEqual(OK);
    expect(await blob("feature/x/src/a.ts#L3")).toMatchObject({
      errorDetail: "src/a.ts has only 2 lines",
    });
  });

  it("resolves refs of any length with one listing of branches and one of tags", async () => {
    mockRefs(["heads/a/b/c/d/e", "heads/a/b/x", "tags/a/b"]);
    mockFileAt("a/b/c/d/e", "src/f.ts", "one\n");

    await run(async () => {
      expect(await check("https://github.com/o/r/blob/a/b/c/d/e/src/f.ts#L1")).toEqual(OK);
      expect(await check("https://github.com/o/r/blob/a/b/c/d/e/src/f.ts")).toEqual(OK);
    });

    expect(
      api.git.listMatchingRefs.mock.calls
        .map(([params]) => params.ref)
        .toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["heads/a", "tags/a"]);
  });

  it("resolves tag names with slashes (`@scope/pkg@1.0.0`)", async () => {
    mockRefs(["tags/@scope/pkg@1.0.0", "tags/@scope/other@2.0.0"]);
    mockFileAt("@scope/pkg@1.0.0", "README.md", "# Title\n");

    expect(await blob("@scope/pkg@1.0.0/README.md#title")).toEqual(OK);
  });

  it("tries a shorter ref if the longest one has no such file (a branch `a/b` and a tag `a/b/c`)", async () => {
    mockRefs(["heads/a/b", "tags/a/b/c"]);
    mockFileAt("a/b", "c/f.ts", "one\n");

    expect(await blob("a/b/c/f.ts#L1")).toEqual(OK);
  });

  it("prefers the longest ref when shorter ones have the path too", async () => {
    mockRefs(["heads/a/b", "tags/a/b/c"]);
    api.repos.getContent.mockImplementation(async ({ ref, path }) => {
      if (ref === "a/b/c" && path === "f.ts") return fileContent("1\n2\n3\n");
      if (ref === "a/b" && path === "c/f.ts") return fileContent("1\n");
      throw notFound();
    });

    expect(await blob("a/b/c/f.ts#L3")).toEqual(OK);
  });

  it("never takes the whole path of a blob as the ref", async () => {
    api.repos.getContent.mockRejectedValue(notFound());
    mockRefs(["heads/a-b", "heads/a/b/c/d/e/f/g.ts"]);

    expect(await blob("a/b/c/d/e/f/g.ts#L1")).toMatchObject({ error: "broken link", status: 404 });
  });

  it("accepts a tree link to a branch with slashes (proven by the listing) and a path in it", async () => {
    mockRefs(["heads/feature/a/b/c/d"]);
    api.repos.getContent.mockImplementation(async ({ ref }) => {
      if (ref !== "feature/a/b/c/d") {
        throw notFound();
      }
      return directoryContent();
    });

    expect(await tree("feature/a/b/c/d/src")).toEqual(OK);
    expect(await tree("feature/a/b/c/d")).toEqual(OK);
    expect(await tree("feature/a/b/c/missing")).toMatchObject({
      error: "broken link",
      status: 404,
      // The first segment, the URL doesn't say where the ref ends
      errorDetail: "Path a/b/c/missing not found in branch, tag or commit feature",
    });
  });

  it("reports a missing repository (no refs listed) as broken link", async () => {
    api.repos.getContent.mockRejectedValue(notFound());
    api.git.listMatchingRefs.mockRejectedValue(notFound());

    expect(await blob("feature/x/src/a.ts")).toMatchObject({ error: "broken link", status: 404 });
  });

  it("does not list refs after an error that is not 'not found'", async () => {
    api.repos.getContent.mockRejectedValue(apiError(500));

    expect(await blob("feature/x/src/a.ts#L2")).toMatchObject({
      error: "unexpected error",
      status: 500,
    });
    expect(api.git.listMatchingRefs).not.toHaveBeenCalled();
  });

  it("reports a failing ref listing as 'unexpected error', not broken", async () => {
    api.repos.getContent.mockRejectedValue(notFound());
    api.git.listMatchingRefs.mockRejectedValue(apiError(403));

    expect(await blob("feature/x/src/a.ts")).toMatchObject({
      error: "unexpected error",
      status: 403,
    });
  });
});

/** The API method each URL of `URL_PER_LINK_TYPE` sends its first request to */
const firstRequestOf = (url: string) => {
  const path = new URL(url).pathname.split("/").slice(3, 5).join("/");
  if (!path) return url === "https://github.com/o/r" ? api.repos.get : api.users.getByUsername;
  if (path.startsWith("blob") || path.startsWith("tree")) return api.repos.getContent;
  if (path === "releases/123") return api.repos.getRelease;
  if (path === "releases/latest") return api.repos.getLatestRelease;
  if (path.startsWith("releases")) return api.repos.getReleaseByTag;
  if (path.startsWith("commit")) return api.repos.getCommit;
  if (path.startsWith("issues")) return api.issues.get;
  if (path.startsWith("pull")) return api.pulls.get;
  return api.graphql;
};

describe("checkLinkWithGithubApi() caching", () => {
  beforeEach(() => {
    api.repos.getContent.mockResolvedValue(fileContent("a\nb\nc\n"));
    api.repos.getReleaseByTag.mockResolvedValue({ data: { assets: [{ name: "a.zip" }] } });
  });

  it.each(URL_PER_LINK_TYPE)(
    "sends one request for repeated checks of %s in a run",
    async (url) => {
      await run(async () => {
        const results = await Promise.all([check(url), check(url)]);
        results.push(await check(url));
        expect(results.every((result) => result.ok)).toBe(true);
      });
      expect(firstRequestOf(url)).toHaveBeenCalledTimes(1);
    },
  );

  it.each<[string, string, () => void]>([
    ["404", "https://github.com/o/r", () => api.repos.get.mockRejectedValue(notFound())],
    [
      "410",
      "https://github.com/o/r/issues/1",
      () => api.issues.get.mockRejectedValue(apiError(410)),
    ],
    [
      "422 of a commit",
      "https://github.com/o/r/commit/abc1234",
      () => api.repos.getCommit.mockRejectedValue(apiError(422)),
    ],
    [
      "GraphQL NOT_FOUND",
      "https://github.com/o/r/discussions/1",
      () => api.graphql.mockRejectedValue(graphqlError("Could not resolve", "NOT_FOUND")),
    ],
  ])("caches a definitive 'not found' (%s)", async (_, url, arrange) => {
    arrange();
    await run(async () => {
      for (let i = 0; i < 2; i++) {
        expect(await check(url)).toMatchObject({ ok: false, error: "broken link" });
      }
    });
    expect(firstRequestOf(url)).toHaveBeenCalledTimes(1);
  });

  // Rate limits, bad token or no access, server errors: no proof the resource is missing, ask again next time
  it.each([401, 403, 422, 502])("does not cache %i of a repository", async (status) => {
    api.repos.get.mockRejectedValue(apiError(status));
    await run(async () => {
      for (let i = 0; i < 2; i++) {
        expect(await check("https://github.com/o/r")).toMatchObject({
          error: "unexpected error",
          status,
        });
      }
    });
    expect(api.repos.get).toHaveBeenCalledTimes(2);
  });

  it("ignores the case of owner and repository names, not of refs and paths", async () => {
    await run(async () => {
      await check("https://github.com/o/r");
      await check("https://github.com/O/R");
      await check("https://github.com/o/r/blob/main/README.md");
      await check("https://github.com/O/R/blob/main/README.md");
      await check("https://github.com/o/r/blob/Main/README.md");
      await check("https://github.com/o/r/blob/main/readme.md");
    });
    expect(api.repos.get).toHaveBeenCalledTimes(1);
    expect(api.repos.getContent).toHaveBeenCalledTimes(3);
  });

  it("checks many hashes of the same file with one request", async () => {
    api.repos.getContent.mockResolvedValue(fileContent("# Title\n## Usage\n"));
    const file = "https://github.com/o/r/blob/main/README.md";

    const results = await run(() =>
      Promise.all(
        ["", "#title", "#usage", "#missing", "#L2"].map((hash) => check(`${file}${hash}`)),
      ),
    );

    expect(results.map((result) => result.ok)).toEqual([true, true, true, false, true]);
    expect(api.repos.getContent).toHaveBeenCalledTimes(1);
  });

  it("does not share the cache between runs", async () => {
    await checkInRun("https://github.com/o/r");
    await checkInRun("https://github.com/o/r");
    expect(api.repos.get).toHaveBeenCalledTimes(2);
  });

  it("counts cache hits in the run metrics (requests are counted by the Octokit client)", async () => {
    await run(async () => {
      await Promise.all([
        check("https://github.com/o/r/issues/1"),
        check("https://github.com/o/r/issues/1"),
        check("https://github.com/o/r"),
      ]);
      expect(getRunContext()?.metrics.counters).toMatchObject({ githubCacheHits: 1 });
    });
  });
});

describe("checkLinkWithGithubApi() timeouts", () => {
  const timedOut = (url: string) => withTimeout((signal) => check(url, signal), 5, "timed out");

  it("aborts the request of a check that timed out", async () => {
    const answer = answerAfter(50, { data: {} });
    api.issues.get.mockImplementation(answer);

    await run(() =>
      expect(timedOut("https://github.com/o/r/issues/1")).rejects.toThrow("timed out"),
    );
    await delay(10);

    expect(answer.aborted).toHaveLength(1);
  });

  it("does not abort a request that another check still waits for", async () => {
    const answer = answerAfter(20, { data: { default_branch: "main" } });
    api.repos.get.mockImplementation(answer);

    await run(async () => {
      const first = timedOut("https://github.com/o/r");
      const second = check("https://github.com/o/r");

      await expect(first).rejects.toThrow("timed out");
      expect(await second).toEqual(OK);
    });
    expect(api.repos.get).toHaveBeenCalledTimes(1);
    expect(answer.aborted).toEqual([]);
  });

  it("sends the request again after an aborted one", async () => {
    api.issues.get.mockImplementation(answerAfter(20, { data: {} }));

    await run(async () => {
      await expect(timedOut("https://github.com/o/r/issues/1")).rejects.toThrow("timed out");
      expect(await check("https://github.com/o/r/issues/1")).toEqual(OK);
    });
    expect(api.issues.get).toHaveBeenCalledTimes(2);
  });

  it("sends no request for an already aborted check", async () => {
    const controller = new AbortController();
    controller.abort(new Error("timed out"));

    const result = await run(() => check("https://github.com/o/r/issues/1", controller.signal));

    expect(result).toMatchObject({ ok: false, error: "unexpected error" });
    expect(api.issues.get).not.toHaveBeenCalled();
  });

  it("sends no more requests once the check timed out", async () => {
    api.repos.getContent.mockImplementation(async () => {
      await delay(20);
      throw notFound();
    });

    // `feature/x` can be a branch: after "not found" for `feature`, the check would list branches and tags
    await run(() =>
      expect(timedOut("https://github.com/o/r/blob/feature/x/README.md")).rejects.toThrow(
        "timed out",
      ),
    );
    await delay(40);

    expect(api.git.listMatchingRefs).not.toHaveBeenCalled();
  });

  it("a timed-out check does not fail other checks of the same large file", async () => {
    api.repos.getContent.mockResolvedValue(largeFileContent(4));
    api.git.getBlob.mockImplementation(answerAfter(20, { data: { content: btoa("a\nb\n") } }));
    const url = "https://github.com/o/r/blob/main/big.txt";

    await run(async () => {
      const first = timedOut(`${url}#L1`);
      const second = check(`${url}#L2`);

      await expect(first).rejects.toThrow("timed out");
      expect(await second).toEqual(OK);
    });
  });
});
