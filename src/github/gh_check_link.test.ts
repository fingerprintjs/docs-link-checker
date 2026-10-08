import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { GitHubApiError } from "../errors";
import { fakeFetch } from "../test/fake_fetch";
import { fakeGitHub } from "../test/fake_github";
import { testRunLayer } from "../test/layers";
import { checkLinkWithGithubApi } from "./gh_check_link";
import type { FileText, GitHubApi, RepoInfo } from "./github_client";

const apiError = (status: number | undefined, message = `HTTP ${status}`) =>
  new GitHubApiError({ status, cause: new Error(message) });
const failWith = (status: number) => () => Effect.fail(apiError(status));
const notFound = failWith(404);

/** Everything exists, like a repository where every request succeeds */
const existing: Partial<GitHubApi> = {
  getUser: () => Effect.void,
  getRepo: () => Effect.succeed<RepoInfo>({ default_branch: "main" }),
  getCommit: () => Effect.void,
  getIssue: () => Effect.void,
  getPullRequest: () => Effect.void,
  getReleaseByTag: () => Effect.succeed({ assets: [{ name: "a.zip" }] }),
  getContent: () => Effect.succeed({}),
  listRefNames: () => Effect.succeed([]),
};

/** Fails every API request with `status` */
const failing = (status: number): Partial<GitHubApi> => ({
  getUser: failWith(status),
  getRepo: failWith(status),
  getCommit: failWith(status),
  getIssue: failWith(status),
  getPullRequest: failWith(status),
  getReleaseByTag: failWith(status),
  getContent: failWith(status),
});

/** Checks `url` against a fake `GitHub` (default: `existing`), returns the result and the API calls */
const check = (url: string, overrides: Partial<GitHubApi> = {}) => {
  const github = fakeGitHub({ ...existing, ...overrides });
  const page = fakeFetch(() => new Response("<html><body></body></html>"));
  return checkLinkWithGithubApi(url).pipe(
    Effect.provide(testRunLayer({ github: github.layer, fetch: page.layer })),
    Effect.map((result) => ({ result, calls: github.calls, fetched: page.calls })),
  );
};

const OK = { ok: true, status: 200 };

describe("checkLinkWithGithubApi() with percent-encoded paths", () => {
  it.effect("passes a decoded release tag to the API (which encodes it once)", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* check(
        "https://github.com/fingerprintjs/vue/releases/tag/%40fingerprint%2Fvue%402.0.0",
      );

      expect(result).toEqual(OK);
      expect(calls).toEqual(['getReleaseByTag("fingerprintjs", "vue", "@fingerprint/vue@2.0.0")']);
    }),
  );

  it.effect("accepts a release tag with an unencoded slash", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* check(
        "https://github.com/fingerprintjs/vue/releases/tag/@fingerprint/vue@2.0.0",
      );

      expect(result).toEqual(OK);
      expect(calls).toEqual(['getReleaseByTag("fingerprintjs", "vue", "@fingerprint/vue@2.0.0")']);
    }),
  );

  it.effect("reports a missing (decoded) tag as broken link", () =>
    Effect.gen(function* () {
      const { result } = yield* check(
        "https://github.com/fingerprintjs/react-native/releases/tag/v4.0.0",
        { getReleaseByTag: notFound },
      );

      expect(result).toMatchObject({ ok: false, error: "broken link", status: 404 });
    }),
  );

  it.effect("passes a decoded blob path and ref", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* check(
        "https://github.com/o/r/blob/main/docs/my%20file%40v1.md",
      );

      expect(result).toEqual(OK);
      expect(calls).toEqual(['getContent("o", "r", "main", "docs/my file@v1.md")']);
    }),
  );

  it.effect("passes a decoded tree path", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* check("https://github.com/o/r/tree/v1.0/src/%5Bid%5D");

      expect(result).toEqual(OK);
      expect(calls).toEqual(['getContent("o", "r", "v1.0", "src/[id]")']);
    }),
  );

  it.effect("passes a decoded commit ref", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* check("https://github.com/o/r/commit/abc%31234");

      expect(result).toEqual(OK);
      expect(calls).toEqual(['getCommit("o", "r", "abc1234")']);
    }),
  );

  it.effect("does not throw on malformed percent-encoding", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* check("https://github.com/o/r/blob/main/100%.md", {
        getContent: notFound,
      });

      expect(result).toMatchObject({ ok: false, error: "broken link", status: 404 });
      expect(calls[0]).toBe('getContent("o", "r", "main", "100%.md")');
    }),
  );
});

describe("checkLinkWithGithubApi() with user and organization URLs", () => {
  for (const [url, username] of [
    ["https://github.com/frida/", "frida"],
    ["https://github.com/Universal-Commerce-Protocol", "Universal-Commerce-Protocol"],
    ["https://github.com/ua-parser", "ua-parser"],
  ]) {
    it.effect(`checks ${url} as an account, not as a repository`, () =>
      Effect.gen(function* () {
        const { result, calls } = yield* check(url ?? "");

        expect(result).toEqual(OK);
        expect(calls).toEqual([`getUser("${username}")`]);
      }),
    );
  }

  it.effect("still checks repository URLs as repositories", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* check("https://github.com/frida/frida/");

      expect(result).toEqual(OK);
      expect(calls).toEqual(['getRepo("frida", "frida")']);
    }),
  );

  it.effect("accepts github.com itself", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* check("https://github.com/");

      expect(result).toEqual(OK);
      expect(calls).toEqual([]);
    }),
  );
});

describe("checkLinkWithGithubApi() with unknown sections", () => {
  for (const section of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    it.effect(
      `reports /owner/repo/${section}/x as an unknown link type (no inherited object property)`,
      () =>
        Effect.gen(function* () {
          const { result } = yield* check(`https://github.com/o/r/${section}/x`);

          expect(result).toEqual({
            ok: false,
            error: "unexpected error",
            status: 400,
            errorDetail: `Unknown link type: ${section}/x`,
          });
        }),
    );
  }
});

describe("checkLinkWithGithubApi() with unknown account URLs", () => {
  // These fetch the page of an unknown account with `checkLinkWithFetch`, still a stub of the PIPELINE group.
  // Port them with `fakeFetch` when `fetch_check.ts` is implemented (STEP 3).
  it.todo(
    "accepts an unknown account URL whose page exists (a GitHub page missing from the reserved routes)",
  );
  it.todo(
    "reports the API 404 as broken link when the page of an unknown account answers 404 or 429",
  );

  it.effect("does not fetch the page of an existing account", () =>
    Effect.gen(function* () {
      const { fetched } = yield* check("https://github.com/fingerprintjs");

      expect(fetched).toHaveLength(0);
    }),
  );
});

describe("GitHub API errors", () => {
  // 401 (bad token), 403 (rate limits after Octokit's retry, no access) and 5xx say nothing about the link
  for (const status of [401, 403, 502, 503]) {
    it.effect(`reports ${status} as unexpected error (not broken) for every link type`, () =>
      Effect.gen(function* () {
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
          const { result } = yield* check(url, failing(status));
          expect({ url, result }).toMatchObject({
            url,
            result: { ok: false, error: "unexpected error", status },
          });
        }
      }),
    );
  }

  it.effect("reports a missing repository as broken link", () =>
    Effect.gen(function* () {
      const { result } = yield* check("https://github.com/owner/missing-repo", {
        getRepo: notFound,
      });

      expect(result).toMatchObject({ ok: false, error: "broken link", status: 404 });
    }),
  );

  it.effect("reports a missing branch or commit as broken link", () =>
    Effect.gen(function* () {
      const { result } = yield* check("https://github.com/o/r/tree/missing", {
        getContent: notFound,
      });

      expect(result).toMatchObject({
        ok: false,
        error: "broken link",
        status: 404,
        errorDetail: "No branch, tag or commit missing found in repository o/r",
      });
    }),
  );

  it.effect("reports a deleted issue (410 Gone) as broken link", () =>
    Effect.gen(function* () {
      const { result } = yield* check("https://github.com/o/r/issues/1", {
        getIssue: failWith(410),
      });

      expect(result).toMatchObject({ ok: false, error: "broken link", status: 410 });
    }),
  );
});

describe("checkLinkWithGithubApi() with URL variants", () => {
  for (const url of [
    "https://github.com/o/r/issues",
    "https://github.com/o/r/issues/",
    "https://github.com/o/r/discussions",
    "https://github.com/o/r/releases",
    "https://github.com/o/r/pulls",
    "https://github.com/o/r?tab=readme-ov-file",
    "https://github.com/o/r/?tab=readme-ov-file",
  ]) {
    it.effect(`checks ${url} as the repository`, () =>
      Effect.gen(function* () {
        const { result, calls } = yield* check(url);

        expect(result).toEqual(OK);
        expect(calls).toEqual(['getRepo("o", "r")']);
      }),
    );
  }

  it.effect("ignores the query string of a tree link", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* check("https://github.com/o/r/tree/master?ref=main");

      expect(result).toEqual(OK);
      expect(calls).toEqual(['getContent("o", "r", "master", "")']);
    }),
  );
});

describe("checkLinkWithGithubApi() with tree links", () => {
  it.effect("resolves branch names with slashes, with or without a path", () => {
    const branch = {
      listRefNames: (_owner: string, _repo: string, kind: "heads" | "tags", prefix: string) =>
        Effect.succeed(kind === "heads" && prefix === "feature" ? ["feature/a/b/c/d"] : []),
      getContent: (_owner: string, _repo: string, ref: string) =>
        ref === "feature/a/b/c/d" ? Effect.succeed({}) : notFound(),
    };
    return Effect.gen(function* () {
      const withPath = yield* check("https://github.com/o/r/tree/feature/a/b/c/d/src", branch);
      expect(withPath.result).toEqual(OK);

      // The listing proves the branch exists
      const root = yield* check("https://github.com/o/r/tree/feature/a/b/c/d", branch);
      expect(root.result).toEqual(OK);

      const missing = yield* check("https://github.com/o/r/tree/feature/a/b/c/missing", branch);
      expect(missing.result).toMatchObject({ ok: false, error: "broken link", status: 404 });
    });
  });
});

describe("checkLinkWithGithubApi() with code line links", () => {
  const fileText = (text: string): FileText => ({
    text,
    binary: false,
    getAnchors: () => new Set<string>(),
  });
  const file = {
    getContent: () => Effect.succeed({ content: "b25lCnR3bwo=", sha: "sha" }),
    getFileText: () => Effect.succeed(fileText("one\ntwo\n")),
  };

  it.effect("routes a code line link to the blob check (the file is read with the API)", () =>
    Effect.gen(function* () {
      const inside = yield* check("https://github.com/o/r/blob/main/a.txt#L2", file);
      const outside = yield* check("https://github.com/o/r/blob/main/a.txt#L3", file);

      expect(inside.result).toEqual(OK);
      expect(outside.result).toMatchObject({ ok: false, error: "hash not found" });
    }),
  );

  it.effect(
    "reports 'unexpected error' without a GH_TOKEN (checkLinks re-checks it in the browser)",
    () =>
      Effect.gen(function* () {
        const message = "GH_TOKEN is not set. A GitHub token is required to check GitHub links.";
        const { result } = yield* check("https://github.com/o/r/blob/main/a.ts#L3", {
          getContent: () =>
            Effect.fail(new GitHubApiError({ status: undefined, cause: new Error(message) })),
        });

        expect(result).toMatchObject({
          ok: false,
          error: "unexpected error",
          errorDetail: expect.stringContaining("GH_TOKEN is not set"),
        });
      }),
  );
});
