import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getContent, getBlob, listMatchingRefs } = vi.hoisted(() => ({
  getContent: vi.fn(),
  getBlob: vi.fn(),
  listMatchingRefs: vi.fn(),
}));

vi.mock("../github_client", () => ({
  getMyOctokit: () => ({
    repos: { getContent },
    git: { getBlob, listMatchingRefs },
    // All pages of a list endpoint: the mocks return a single page
    paginate: async (fn: (params: unknown) => Promise<{ data: unknown[] }>, params: unknown) =>
      (await fn(params)).data,
  }),
}));

import { checkLinkWithGithubApi } from "../gh_check_link";

const readme = readFileSync(
  join(import.meta.dirname, "..", "..", "__fixtures__", "readme.md"),
  "utf8",
);

const checkHash = (hash: string) => {
  return checkLinkWithGithubApi(`https://github.com/owner/repo/blob/main/README.md${hash}`);
};

beforeEach(() => {
  getBlob.mockReset();
  listMatchingRefs.mockReset();
  listMatchingRefs.mockResolvedValue({ data: [] });
  getContent.mockReset();
  getContent.mockResolvedValue({
    data: { type: "file", content: Buffer.from(readme).toString("base64") },
  });
});

describe("checkLinkWithGithubApi() with blob links (mocked GitHub API)", () => {
  it.each([
    "",
    "#installation",
    "#usage-1",
    "#custom-anchor",
    "#InStAlLaTiOn",
    "#user-content-installation",
  ])("returns OK for %s", async (hash) => {
    expect(await checkHash(hash)).toEqual({ ok: true, status: 200 });
  });

  it("returns 'hash not found' for code block comments", async () => {
    expect(await checkHash("#not-a-heading")).toEqual({
      ok: false,
      error: "hash not found",
      status: 200,
      errorDetail: "No heading found matching hash: not-a-heading",
    });
  });

  it("decodes percent-encoded hashes", async () => {
    getContent.mockResolvedValue({
      data: { type: "file", content: Buffer.from("## Café\n").toString("base64") },
    });
    expect(await checkHash("#caf%C3%A9")).toEqual({ ok: true, status: 200 });
  });

  it("returns broken link when the API returns 404", async () => {
    getContent.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
    expect(await checkHash("")).toMatchObject({ ok: false, error: "broken link", status: 404 });
  });
});

const base64 = (text: string | Buffer) => Buffer.from(text).toString("base64");
const file = (text: string | Buffer) => ({
  data: { type: "file", sha: "abc", size: Buffer.from(text).length, content: base64(text) },
});
const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });

const checkBlob = (refAndPath: string, hash = "") =>
  checkLinkWithGithubApi(`https://github.com/owner/repo/blob/${refAndPath}${hash}`);

describe("checkLinkWithGithubApi() with code line links (mocked GitHub API)", () => {
  beforeEach(() => {
    // 3 lines, the trailing newline does not start a 4th one
    getContent.mockResolvedValue(file("one\ntwo\nthree\n"));
  });

  it.each(["#L1", "#L3", "#L1-L3", "#L2-L2", "#%4C2", "#L2C5", "#L2C5-L3C1", "#L1-L3C2"])(
    "accepts %s within the file",
    async (hash) => {
      expect(await checkBlob("main/src/a.ts", hash)).toEqual({ ok: true, status: 200 });
    },
  );

  it.each(["#L4", "#L2-L4", "#L99999", "#L8888-L9999", "#L2C5-L4C1", "#L4C1"])(
    "reports %s past the end of the file as 'hash not found'",
    async (hash) => {
      expect(await checkBlob("main/src/a.ts", hash)).toEqual({
        ok: false,
        error: "hash not found",
        status: 200,
        errorDetail: "src/a.ts has only 3 lines",
      });
    },
  );

  it.each(["#L0", "#L3-L2", "#L0-L1"])("reports %s as an invalid line anchor", async (hash) => {
    expect(await checkBlob("main/src/a.ts", hash)).toMatchObject({
      ok: false,
      error: "hash not found",
      errorDetail: expect.stringContaining("Invalid line anchor"),
    });
  });

  it("asks the API for the file once for all its line hashes in a run", async () => {
    const { withRun } = await import("../../run");
    await withRun({}, async () => {
      await Promise.all(["#L1", "#L2", "#L9"].map((hash) => checkBlob("main/src/a.ts", hash)));
    });
    expect(getContent).toHaveBeenCalledTimes(1);
    expect(getContent).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      ref: "main",
      path: "src/a.ts",
    });
  });

  it("reads files over 1 MB with the blob API (no content in the contents API)", async () => {
    const big = "x\n".repeat(200_000);
    getContent.mockResolvedValue({
      data: { type: "file", sha: "bigsha", size: big.length, encoding: "none", content: "" },
    });
    getBlob.mockResolvedValue({ data: { content: base64(big), encoding: "base64" } });

    expect(await checkBlob("main/big.txt", "#L200000")).toEqual({ ok: true, status: 200 });
    expect(await checkBlob("main/big.txt", "#L200001")).toMatchObject({
      error: "hash not found",
      errorDetail: "big.txt has only 200000 lines",
    });
    expect(getBlob).toHaveBeenCalledWith({ owner: "owner", repo: "repo", file_sha: "bigsha" });
  });

  it("reports line anchors on binary files as 'hash not found'", async () => {
    getContent.mockResolvedValue(file(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0x01])));

    expect(await checkBlob("main/logo.png", "#L1")).toMatchObject({
      ok: false,
      error: "hash not found",
      errorDetail: "logo.png (binary file) has only 0 lines",
    });
  });

  it("reports line anchors on directories as 'hash not found'", async () => {
    getContent.mockResolvedValue({ data: [{ type: "file", name: "a.ts" }] });

    expect(await checkBlob("main/src", "#L1")).toMatchObject({
      ok: false,
      error: "hash not found",
    });
  });

  it("reports a missing file (or private repository) as broken link", async () => {
    getContent.mockRejectedValue(notFound());

    expect(await checkBlob("main/src/missing.ts", "#L1")).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
    });
  });

  it.each([
    ["server error", 503],
    ["rate limit", 429],
    ["rate limit or no access", 403],
    ["bad token", 401],
    ["network error", undefined],
  ])("reports a %s as 'unexpected error' (re-checked in the browser)", async (_name, status) => {
    getContent.mockRejectedValue(Object.assign(new Error("Failed"), { status }));

    const result = await checkBlob("main/src/a.ts", "#L1");

    expect(result).toMatchObject({ ok: false, error: "unexpected error" });
    expect(!result.ok && result.status).toBe(status);
  });

  it("reports a failing blob API request (large file) as 'unexpected error'", async () => {
    getContent.mockResolvedValue({
      data: { type: "file", sha: "bigsha", size: 2_000_000, encoding: "none", content: "" },
    });
    getBlob.mockRejectedValue(Object.assign(new Error("Server Error"), { status: 502 }));

    expect(await checkBlob("main/big.txt", "#L1")).toMatchObject({
      ok: false,
      error: "unexpected error",
      status: 502,
    });
  });

  /** Branches and tags of the mocked repository (`heads/feature/x`, `tags/v1`) */
  const mockRefs = (refs: string[]) => {
    listMatchingRefs.mockImplementation(async ({ ref }: { ref: string }) => ({
      // Prefix match like the API: `heads/feature` matches `heads/feature-2` too
      data: refs.filter((name) => name.startsWith(ref)).map((name) => ({ ref: `refs/${name}` })),
    }));
  };
  /** The file exists only at `ref` */
  const mockFileAt = (fileRef: string, filePath: string, text: string) => {
    getContent.mockImplementation(async ({ ref, path }: { ref: string; path: string }) => {
      if (ref !== fileRef || path !== filePath) {
        throw notFound();
      }
      return file(text);
    });
  };
  const contentCalls = () => getContent.mock.calls.map(([params]) => [params.ref, params.path]);

  it("resolves branch names with slashes (`feature/x`)", async () => {
    mockRefs(["heads/feature", "heads/feature-2", "heads/feature/x"]);
    mockFileAt("feature/x", "src/a.ts", "a\nb\n");

    expect(await checkBlob("feature/x/src/a.ts", "#L2")).toEqual({ ok: true, status: 200 });
    expect(await checkBlob("feature/x/src/a.ts", "#L3")).toMatchObject({
      errorDetail: "src/a.ts has only 2 lines",
    });
    expect(contentCalls()).toContainEqual(["feature/x", "src/a.ts"]);
  });

  it("resolves branch names of any length (5 segments) with one listing of branches and tags", async () => {
    mockRefs(["heads/a/b/c/d/e", "heads/a/b/x", "tags/a/b"]);
    mockFileAt("a/b/c/d/e", "src/f.ts", "one\n");

    const { withRun } = await import("../../run");
    await withRun({}, async () => {
      expect(await checkBlob("a/b/c/d/e/src/f.ts", "#L1")).toEqual({ ok: true, status: 200 });
      expect(await checkBlob("a/b/c/d/e/src/f.ts")).toEqual({ ok: true, status: 200 });
    });

    // The first segment, then the longest ref that is a prefix of the path, no guessing
    expect(contentCalls()).toEqual([
      ["a", "b/c/d/e/src/f.ts"],
      ["a/b/c/d/e", "src/f.ts"],
    ]);
    // One listing of branches and one of tags for the repository and first segment, cached for the run
    expect(
      listMatchingRefs.mock.calls
        .map(([params]) => params.ref)
        .toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["heads/a", "tags/a"]);
  });

  it("resolves tag names with slashes (`@scope/pkg@1.0.0`)", async () => {
    mockRefs(["tags/@scope/pkg@1.0.0", "tags/@scope/other@2.0.0"]);
    mockFileAt("@scope/pkg@1.0.0", "README.md", "# Title\n");

    expect(await checkBlob("@scope/pkg@1.0.0/README.md", "#title")).toEqual({
      ok: true,
      status: 200,
    });
  });

  it("tries a shorter ref if the longest one has no such file (a branch `a/b` and a tag `a/b/c`)", async () => {
    mockRefs(["heads/a/b", "tags/a/b/c"]);
    mockFileAt("a/b", "c/f.ts", "one\n");

    expect(await checkBlob("a/b/c/f.ts", "#L1")).toEqual({ ok: true, status: 200 });
    expect(contentCalls()).toEqual([
      ["a", "b/c/f.ts"],
      ["a/b/c", "f.ts"],
      ["a/b", "c/f.ts"],
    ]);
  });

  it("uses a commit SHA (or a ref without slashes) directly, without listing refs", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    mockFileAt(sha, "src/a.ts", "a\nb\n");

    expect(await checkBlob(`${sha}/src/a.ts`, "#L2")).toEqual({ ok: true, status: 200 });
    expect(listMatchingRefs).not.toHaveBeenCalled();
  });

  it("reports a missing file at a commit SHA as broken link", async () => {
    getContent.mockRejectedValue(notFound());

    expect(
      await checkBlob("0123456789abcdef0123456789abcdef01234567/src/missing.ts", "#L1"),
    ).toMatchObject({ ok: false, error: "broken link", status: 404 });
  });

  it("reports a nonexistent ref as broken link, a ref is never the whole path", async () => {
    getContent.mockRejectedValue(notFound());
    // `a/b/c/d/e/f/g.ts` is a branch, but a blob URL needs a file path after the ref
    mockRefs(["heads/a-b", "heads/a/b/c/d/e/f/g.ts"]);

    expect(await checkBlob("a/b/c/d/e/f/g.ts", "#L1")).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
    });
    // Only the first segment: no listed ref is a prefix of the path
    expect(getContent).toHaveBeenCalledTimes(1);
  });

  it("reports a missing repository (no refs listed) as broken link", async () => {
    getContent.mockRejectedValue(notFound());
    listMatchingRefs.mockRejectedValue(notFound());

    expect(await checkBlob("feature/x/src/a.ts")).toMatchObject({
      error: "broken link",
      status: 404,
    });
  });

  it("does not try longer refs after an error that is not 'not found'", async () => {
    getContent.mockRejectedValue(Object.assign(new Error("Server Error"), { status: 500 }));

    await checkBlob("feature/x/src/a.ts", "#L2");

    expect(getContent).toHaveBeenCalledTimes(1);
    expect(listMatchingRefs).not.toHaveBeenCalled();
  });

  it("reports a failing ref listing as 'unexpected error', not broken", async () => {
    getContent.mockRejectedValue(notFound());
    listMatchingRefs.mockRejectedValue(Object.assign(new Error("Forbidden"), { status: 403 }));

    expect(await checkBlob("feature/x/src/a.ts")).toMatchObject({
      ok: false,
      error: "unexpected error",
      status: 403,
    });
  });

  it("checks line anchors on rendered markdown against the lines, a heading `L12` matches too", async () => {
    getContent.mockResolvedValue(file("# Title\n\n## L12\n"));

    expect(await checkBlob("main/README.md", "#L3")).toEqual({ ok: true, status: 200 });
    expect(await checkBlob("main/README.md", "#L12")).toEqual({ ok: true, status: 200 });
    expect(await checkBlob("main/README.md", "#L13")).toMatchObject({ error: "hash not found" });
    // `?plain=1` shows the source: only lines
    expect(await checkBlob("main/README.md", "?plain=1#L12")).toMatchObject({
      error: "hash not found",
      errorDetail: "README.md has only 3 lines",
    });
  });
});
