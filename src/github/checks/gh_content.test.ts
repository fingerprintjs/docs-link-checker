import { readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Logger, LogLevel } from "effect";
import { describe, expect } from "vitest";
import { GitHubApiError } from "../../errors";
import type { Fetch } from "../../http";
import { HostLimiter } from "../../limiter";
import { Metrics } from "../../metrics";
import { fakeFetch } from "../../test/fake_fetch";
import { fakeGitHub } from "../../test/fake_github";
import { testRunLayer } from "../../test/layers";
import { checkLinkWithGithubApi } from "../gh_check_link";
import { GitHub } from "../github_client";

const readme = readFileSync(
  join(import.meta.dirname, "..", "..", "__fixtures__", "readme.md"),
  "utf8",
);

/** What the fake repository `owner/repo` answers to a contents API request for `<ref>:<path>` */
type Entry =
  | string
  | Buffer
  | { readonly directory: true }
  // Over 1 MB: the contents API sends no content, the blobs API does
  | { readonly large: string }
  | { readonly status: number };

type Repo = {
  /** Key: `<ref>:<path>`, anything else is a 404 */
  readonly files?: Readonly<Record<string, Entry>>;
  /** Branches and tags as `heads/feature/x`, `tags/v1` */
  readonly refs?: ReadonlyArray<string>;
  /** Status of the ref listing instead of the refs */
  readonly refsStatus?: number;
  /** Status of the blobs API instead of the content of a large file */
  readonly blobStatus?: number;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const contentResponse = (entry: Entry) => {
  if (typeof entry === "string" || Buffer.isBuffer(entry)) {
    return json({
      type: "file",
      sha: "abc",
      size: Buffer.from(entry).length,
      encoding: "base64",
      content: Buffer.from(entry).toString("base64"),
    });
  }
  if ("directory" in entry) {
    return json([{ type: "file", name: "a.ts" }]);
  }
  if ("large" in entry) {
    return json({ type: "file", sha: "bigsha", size: 2_000_000, encoding: "none", content: "" });
  }
  return json({ message: "Failed" }, entry.status);
};

type RepoApi = {
  /** Checks `https://github.com/owner/repo/blob/<refAndPath><hash>` */
  readonly checkBlob: (
    refAndPath: string,
    hash?: string,
  ) => ReturnType<typeof checkLinkWithGithubApi>;
  /** Number of ref listings (branches and tags) requested so far */
  readonly refListings: () => number;
};

/**
 * Runs `use` against the real `GitHub` service (caches, decoding) over a fake `fetch` that serves `repo`.
 * All checks of one `use` share the caches, like the checks of one run.
 */
const withRepo = <A, E>(
  repo: Repo,
  use: (api: RepoApi) => Effect.Effect<A, E, GitHub | Fetch | HostLimiter | Metrics>,
) => {
  const { files = {}, refs = [], refsStatus, blobStatus } = repo;
  const fake = fakeFetch((url) => {
    const { pathname, searchParams } = new URL(url);
    const path = decodeURIComponent(pathname).replace("/repos/owner/repo", "");
    if (path.startsWith("/git/matching-refs/")) {
      const prefix = path.slice("/git/matching-refs/".length);
      // Prefix match like the API: `heads/feature` matches `heads/feature-2` too
      return refsStatus
        ? json({ message: "Failed" }, refsStatus)
        : json(
            refs.filter((name) => name.startsWith(prefix)).map((name) => ({ ref: `refs/${name}` })),
          );
    }
    if (path.startsWith("/git/blobs/")) {
      const large = Object.values(files).find(
        (entry) => typeof entry === "object" && "large" in entry,
      );
      return blobStatus
        ? json({ message: "Failed" }, blobStatus)
        : json({
            content: Buffer.from(large && "large" in large ? large.large : "").toString("base64"),
            encoding: "base64",
          });
    }
    const entry = files[`${searchParams.get("ref")}:${path.replace(/^\/contents\/?/, "")}`];
    return entry === undefined ? json({ message: "Not Found" }, 404) : contentResponse(entry);
  });
  const layer = Layer.mergeAll(GitHub.layer, HostLimiter.layer(8)).pipe(
    Layer.provideMerge(Layer.mergeAll(Metrics.layer, fake.layer)),
  );
  return use({
    checkBlob: (refAndPath, hash = "") =>
      checkLinkWithGithubApi(`https://github.com/owner/repo/blob/${refAndPath}${hash}`),
    refListings: () => fake.calls.filter(({ url }) => url.includes("/git/matching-refs/")).length,
  }).pipe(
    Effect.provide(layer),
    Effect.withConfigProvider(ConfigProvider.fromMap(new Map([["GH_TOKEN", "test-token"]]))),
    Effect.provide(Logger.minimumLogLevel(LogLevel.None)),
  );
};

const OK = { ok: true, status: 200 };

describe("checkLinkWithGithubApi() with blob links (fake GitHub API)", () => {
  describe("heading hashes", () => {
    const checkHash = (hash: string, text = readme) =>
      withRepo({ files: { "main:README.md": text } }, ({ checkBlob }) =>
        checkBlob("main/README.md", hash),
      );

    for (const hash of ["", "#installation", "#InStAlLaTiOn"]) {
      it.effect(`returns OK for ${hash}`, () =>
        Effect.map(checkHash(hash), (result) => expect(result).toEqual(OK)),
      );
    }

    it.effect("returns 'hash not found' for code block comments", () =>
      Effect.map(checkHash("#not-a-heading"), (result) =>
        expect(result).toEqual({
          ok: false,
          error: "hash not found",
          status: 200,
          errorDetail: "No heading found matching hash: not-a-heading",
        }),
      ),
    );

    it.effect("decodes percent-encoded hashes", () =>
      Effect.map(checkHash("#caf%C3%A9", "## Café\n"), (result) => expect(result).toEqual(OK)),
    );

    it.effect("accepts a directory without hash", () =>
      withRepo({ files: { "main:src": { directory: true } } }, ({ checkBlob }) =>
        Effect.map(checkBlob("main/src"), (result) => expect(result).toEqual(OK)),
      ),
    );
  });

  describe("code line hashes", () => {
    // 3 lines, the trailing newline does not start a 4th one
    const threeLines = { files: { "main:src/a.ts": "one\ntwo\nthree\n" } };

    // Anchor grammar is covered by line_anchor.test.ts, here: wiring, line counting, percent-decoding
    for (const hash of ["#L3", "#%4C2"]) {
      it.effect(`accepts ${hash} within the file`, () =>
        withRepo(threeLines, ({ checkBlob }) =>
          Effect.map(checkBlob("main/src/a.ts", hash), (result) => expect(result).toEqual(OK)),
        ),
      );
    }

    for (const hash of ["#L4", "#L2-L4"]) {
      it.effect(`reports ${hash} past the end of the file as 'hash not found'`, () =>
        withRepo(threeLines, ({ checkBlob }) =>
          Effect.map(checkBlob("main/src/a.ts", hash), (result) =>
            expect(result).toEqual({
              ok: false,
              error: "hash not found",
              status: 200,
              errorDetail: "src/a.ts has only 3 lines",
            }),
          ),
        ),
      );
    }

    it.effect("reports an invalid line anchor as 'hash not found'", () =>
      withRepo(threeLines, ({ checkBlob }) =>
        Effect.map(checkBlob("main/src/a.ts", "#L0"), (result) =>
          expect(result).toMatchObject({
            ok: false,
            error: "hash not found",
            errorDetail: expect.stringContaining("Invalid line anchor"),
          }),
        ),
      ),
    );

    it.effect("reads files over 1 MB with the blob API (no content in the contents API)", () =>
      withRepo({ files: { "main:big.txt": { large: "x\n".repeat(200_000) } } }, ({ checkBlob }) =>
        Effect.gen(function* () {
          expect(yield* checkBlob("main/big.txt", "#L200000")).toEqual(OK);
          expect(yield* checkBlob("main/big.txt", "#L200001")).toMatchObject({
            error: "hash not found",
            errorDetail: "big.txt has only 200000 lines",
          });
        }),
      ),
    );

    it.effect("reports line anchors on binary files as 'hash not found'", () =>
      withRepo(
        { files: { "main:logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0x01]) } },
        ({ checkBlob }) =>
          Effect.map(checkBlob("main/logo.png", "#L1"), (result) =>
            expect(result).toMatchObject({
              ok: false,
              error: "hash not found",
              errorDetail: "logo.png (binary file) has only 0 lines",
            }),
          ),
      ),
    );

    it.effect("reports line anchors on directories as 'hash not found'", () =>
      withRepo({ files: { "main:src": { directory: true } } }, ({ checkBlob }) =>
        Effect.map(checkBlob("main/src", "#L1"), (result) =>
          expect(result).toMatchObject({ ok: false, error: "hash not found" }),
        ),
      ),
    );

    it.effect("reports a missing file (or private repository) as broken link", () =>
      withRepo({}, ({ checkBlob }) =>
        Effect.map(checkBlob("main/src/missing.ts", "#L1"), (result) =>
          expect(result).toMatchObject({ ok: false, error: "broken link", status: 404 }),
        ),
      ),
    );

    // 401, 403 and 5xx are covered in gh_check_link.test.ts
    for (const [name, status] of [
      ["rate limit", 429],
      ["network error", undefined],
    ] as const) {
      it.effect(`reports a ${name} as 'unexpected error' (re-checked in the browser)`, () => {
        const { layer } = fakeGitHub({
          getContent: () => Effect.fail(new GitHubApiError({ status, cause: "Failed" })),
        });
        return checkLinkWithGithubApi("https://github.com/o/r/blob/main/src/a.ts#L1").pipe(
          Effect.provide(testRunLayer({ github: layer })),
          Effect.map((result) => {
            expect(result).toMatchObject({ ok: false, error: "unexpected error" });
            expect(!result.ok && result.status).toBe(status);
          }),
        );
      });
    }

    it.effect("reports a failing blob API request (large file) as 'unexpected error'", () =>
      withRepo({ files: { "main:big.txt": { large: "x" } }, blobStatus: 403 }, ({ checkBlob }) =>
        Effect.map(checkBlob("main/big.txt", "#L1"), (result) =>
          expect(result).toMatchObject({ ok: false, error: "unexpected error", status: 403 }),
        ),
      ),
    );

    it.effect("resolves branch names with slashes (`feature/x`)", () =>
      withRepo(
        {
          refs: ["heads/feature", "heads/feature-2", "heads/feature/x"],
          files: { "feature/x:src/a.ts": "a\nb\n" },
        },
        ({ checkBlob }) =>
          Effect.gen(function* () {
            expect(yield* checkBlob("feature/x/src/a.ts", "#L2")).toEqual(OK);
            expect(yield* checkBlob("feature/x/src/a.ts", "#L3")).toMatchObject({
              errorDetail: "src/a.ts has only 2 lines",
            });
          }),
      ),
    );

    it.effect(
      "resolves branch names of any length (5 segments) with one listing of branches and tags",
      () =>
        withRepo(
          {
            refs: ["heads/a/b/c/d/e", "heads/a/b/x", "tags/a/b"],
            files: { "a/b/c/d/e:src/f.ts": "one\n" },
          },
          ({ checkBlob, refListings }) =>
            Effect.gen(function* () {
              expect(yield* checkBlob("a/b/c/d/e/src/f.ts", "#L1")).toEqual(OK);
              expect(yield* checkBlob("a/b/c/d/e/src/f.ts")).toEqual(OK);

              // One listing of branches and one of tags for the repository and first segment, cached for the run
              expect(refListings()).toBe(2);
            }),
        ),
    );

    it.effect("resolves tag names with slashes (`@scope/pkg@1.0.0`)", () =>
      withRepo(
        {
          refs: ["tags/@scope/pkg@1.0.0", "tags/@scope/other@2.0.0"],
          files: { "@scope/pkg@1.0.0:README.md": "# Title\n" },
        },
        ({ checkBlob }) =>
          Effect.map(checkBlob("@scope/pkg@1.0.0/README.md", "#title"), (result) =>
            expect(result).toEqual(OK),
          ),
      ),
    );

    it.effect(
      "tries a shorter ref if the longest one has no such file (a branch `a/b` and a tag `a/b/c`)",
      () =>
        withRepo(
          { refs: ["heads/a/b", "tags/a/b/c"], files: { "a/b:c/f.ts": "one\n" } },
          ({ checkBlob }) =>
            Effect.map(checkBlob("a/b/c/f.ts", "#L1"), (result) => expect(result).toEqual(OK)),
        ),
    );

    it.effect("reports a nonexistent ref as broken link, a ref is never the whole path", () =>
      // `a/b/c/d/e/f/g.ts` is a branch, but a blob URL needs a file path after the ref
      withRepo({ refs: ["heads/a-b", "heads/a/b/c/d/e/f/g.ts"] }, ({ checkBlob }) =>
        Effect.map(checkBlob("a/b/c/d/e/f/g.ts", "#L1"), (result) =>
          expect(result).toMatchObject({ ok: false, error: "broken link", status: 404 }),
        ),
      ),
    );

    it.effect("reports a missing repository (no refs listed) as broken link", () =>
      withRepo({ refsStatus: 404 }, ({ checkBlob }) =>
        Effect.map(checkBlob("feature/x/src/a.ts"), (result) =>
          expect(result).toMatchObject({ error: "broken link", status: 404 }),
        ),
      ),
    );

    it.effect("does not try longer refs after an error that is not 'not found'", () =>
      withRepo(
        { files: { "feature:x/src/a.ts": { status: 401 } }, refs: ["heads/feature/x"] },
        ({ checkBlob, refListings }) =>
          Effect.gen(function* () {
            expect(yield* checkBlob("feature/x/src/a.ts", "#L2")).toMatchObject({
              ok: false,
              error: "unexpected error",
              status: 401,
            });
            expect(refListings()).toBe(0);
          }),
      ),
    );

    it.effect("reports a failing ref listing as 'unexpected error', not broken", () =>
      withRepo({ refsStatus: 403 }, ({ checkBlob }) =>
        Effect.map(checkBlob("feature/x/src/a.ts"), (result) =>
          expect(result).toMatchObject({ ok: false, error: "unexpected error", status: 403 }),
        ),
      ),
    );

    it.effect(
      "checks line anchors on rendered markdown against the lines, a heading `L12` matches too",
      () =>
        withRepo({ files: { "main:README.md": "# Title\n\n## L12\n" } }, ({ checkBlob }) =>
          Effect.gen(function* () {
            expect(yield* checkBlob("main/README.md", "#L3")).toEqual(OK);
            expect(yield* checkBlob("main/README.md", "#L12")).toEqual(OK);
            expect(yield* checkBlob("main/README.md", "#L13")).toMatchObject({
              error: "hash not found",
            });
            // `?plain=1` shows the source: only lines
            expect(yield* checkBlob("main/README.md", "?plain=1#L12")).toMatchObject({
              error: "hash not found",
              errorDetail: "README.md has only 3 lines",
            });
          }),
        ),
    );
  });
});
