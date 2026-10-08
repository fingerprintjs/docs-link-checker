import { it } from "@effect/vitest";
import { Effect, Logger, LogLevel } from "effect";
import { describe, expect } from "vitest";
import { GitHubApiError, OrgListError } from "../errors";
import { fakeFetch } from "../test/fake_fetch";
import { fakeGitHub } from "../test/fake_github";
import { testRunLayer } from "../test/layers";
import { getReadmeLinks, getReadmesFromOrg, resolveReadmeHref } from "./gh_get_links";
import type { GitHubApi, OrgRepo, TreeEntry } from "./github_client";

const repo = (name: string, archived = false): OrgRepo => ({
  full_name: `org/${name}`,
  owner: { login: "org" },
  name,
  archived,
});
const repos = ["repo-c", "repo-a", "repo-b", "repo-d"].map((name) => repo(name));

const quiet = Effect.provide(Logger.minimumLogLevel(LogLevel.None));

const tree: TreeEntry[] = [
  { type: "blob", path: "README.md" },
  { type: "blob", path: "docs/readme.md" },
  { type: "blob", path: "index.ts" },
  { type: "tree", path: "readme.md" },
];

/** An organization where every repository has two READMEs on `main` */
const org = (overrides: Partial<GitHubApi> = {}) =>
  fakeGitHub({
    listOrgRepos: () => Effect.succeed(repos),
    getRepo: () => Effect.succeed({ default_branch: "main" }),
    getTreeEntries: () => Effect.succeed(tree),
    ...overrides,
  });

const readmesOf = (github: ReturnType<typeof org>, sampleRate = 1) =>
  getReadmesFromOrg("org", sampleRate).pipe(Effect.provide(github.layer), quiet);

describe("getReadmesFromOrg()", () => {
  it.effect("lists README files of all repositories", () =>
    Effect.gen(function* () {
      const readmes = yield* readmesOf(org());

      expect(readmes).toHaveLength(8);
      expect(readmes).toContainEqual({
        sourcePath: "https://github.com/org/repo-a/blob/main/docs/readme.md",
        downloadUrl: "https://raw.githubusercontent.com/org/repo-a/main/docs/readme.md",
      });
    }),
  );

  it.effect("skips deprecated repositories excluded from org-wide checks", () =>
    Effect.gen(function* () {
      const github = org({
        listOrgRepos: () =>
          Effect.succeed([...repos, repo("fingerprint-pro-segment-source-function")]),
      });
      const readmes = yield* readmesOf(github);

      expect(readmes).toHaveLength(8);
      expect(
        readmes.some((readme) =>
          readme.sourcePath.includes("fingerprint-pro-segment-source-function"),
        ),
      ).toBe(false);
    }),
  );

  it.effect("skips archived repositories", () =>
    Effect.gen(function* () {
      const github = org({ listOrgRepos: () => Effect.succeed([...repos, repo("old", true)]) });
      const readmes = yield* readmesOf(github);

      expect(readmes).toHaveLength(8);
      expect(readmes.some((readme) => readme.sourcePath.includes("/org/old/"))).toBe(false);
    }),
  );

  it.effect("skips a repository whose files cannot be listed, the others are still listed", () =>
    Effect.gen(function* () {
      const github = org({
        getTreeEntries: (_owner, name) =>
          name === "repo-a"
            ? Effect.fail(new GitHubApiError({ status: 403, cause: new Error("Forbidden") }))
            : Effect.succeed([{ type: "blob", path: "README.md" }]),
      });
      const readmes = yield* readmesOf(github);

      expect(readmes.map((readme) => readme.sourcePath).toSorted()).toEqual([
        "https://github.com/org/repo-b/blob/main/README.md",
        "https://github.com/org/repo-c/blob/main/README.md",
        "https://github.com/org/repo-d/blob/main/README.md",
      ]);
    }),
  );

  it.effect("fails with a clear error when the repositories cannot be listed", () =>
    Effect.gen(function* () {
      const github = org({
        listOrgRepos: () =>
          Effect.fail(new GitHubApiError({ status: 401, cause: new Error("Bad credentials") })),
      });
      const error = yield* Effect.flip(readmesOf(github));

      expect(error).toBeInstanceOf(OrgListError);
      expect(error.message).toBe(
        "Failed to list repositories of GitHub organization org: Bad credentials",
      );
    }),
  );

  it.effect("samples README files deterministically", () =>
    Effect.gen(function* () {
      const first = yield* readmesOf(org(), 0.25);
      const second = yield* readmesOf(
        org({ listOrgRepos: () => Effect.succeed(repos.toReversed()) }),
        0.25,
      );

      expect(first).toHaveLength(2);
      expect(second).toEqual(first);
    }),
  );
});

describe("resolveReadmeHref()", () => {
  const page = "https://github.com/fingerprintjs/repository/blob/main/folder/README.md";

  it.each([
    ["https://other.com", "https://other.com"],
    ["#section", `${page}#section`],
    ["/nested/folder", "https://github.com/fingerprintjs/repository/blob/main/nested/folder"],
    ["/nested/file.md", "https://github.com/fingerprintjs/repository/blob/main/nested/file.md"],
    ["../sibling.md", "https://github.com/fingerprintjs/repository/blob/main/sibling.md"],
    ["sibling.md", "https://github.com/fingerprintjs/repository/blob/main/folder/sibling.md"],
  ])("resolves %s to %s", (href, expected) => {
    expect(resolveReadmeHref(href, page)).toBe(expected);
  });
});

describe("getReadmeLinks()", () => {
  const file = (name: string) => ({
    sourcePath: `https://github.com/org/repo/blob/main/${name}/README.md`,
    downloadUrl: `https://raw.githubusercontent.com/org/repo/main/${name}/README.md`,
  });
  const linksOf = (files: ReturnType<typeof file>[], handler: (url: string) => Response) =>
    getReadmeLinks(files).pipe(
      Effect.provide(testRunLayer({ fetch: fakeFetch(handler).layer })),
      quiet,
    );

  it.effect("returns the links of downloaded READMEs, resolved against the README page", () =>
    Effect.gen(function* () {
      const links = yield* linksOf(
        [file("pkg")],
        () => new Response("[abs](https://example.com/) [root](/docs/a.md) [sib](b.md)"),
      );

      const page = "https://github.com/org/repo/blob/main/pkg/README.md";
      expect(links).toEqual([
        { page, href: "https://example.com/", text: "abs" },
        { page, href: "https://github.com/org/repo/blob/main/docs/a.md", text: "root" },
        { page, href: "https://github.com/org/repo/blob/main/pkg/b.md", text: "sib" },
      ]);
    }),
  );

  it.effect("skips READMEs that cannot be downloaded", () =>
    Effect.gen(function* () {
      const links = yield* linksOf([file("gone"), file("ok")], (url) =>
        url.includes("/gone/")
          ? new Response("Not Found", { status: 404 })
          : new Response("[x](https://example.com/)"),
      );

      expect(links.map((link) => link.page)).toEqual([file("ok").sourcePath]);
    }),
  );
});
