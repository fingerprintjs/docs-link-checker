import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RunDeps, withRun } from "../run";
import { getReadmeLinks, getReadmesFromOrg, resolveReadmeHref } from "./github_org";

const octokit = {
  paginate: vi.fn(),
  repos: { listForOrg: {}, get: vi.fn() },
  git: { getTree: vi.fn() },
};
const run = <T>(fn: () => Promise<T>, deps: RunDeps = {}) =>
  withRun({ deps: { octokit: () => octokit as never, ...deps } }, fn);

const repos = ["repo-c", "repo-a", "repo-b", "repo-d"].map((name) => ({
  full_name: `org/${name}`,
  owner: { login: "org" },
  name,
  archived: false,
}));

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  octokit.paginate.mockReset().mockResolvedValue(repos);
  octokit.repos.get.mockReset().mockResolvedValue({ data: { default_branch: "main" } });
  octokit.git.getTree.mockReset().mockResolvedValue({
    data: {
      tree: [
        { type: "blob", path: "README.md" },
        { type: "blob", path: "docs/readme.md" },
        { type: "blob", path: "index.ts" },
      ],
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getReadmesFromOrg()", () => {
  it("lists README files of all repositories", async () => {
    const readmes = await run(() => getReadmesFromOrg("org"));
    expect(readmes).toHaveLength(8);
    expect(readmes).toContainEqual({
      sourcePath: "https://github.com/org/repo-a/blob/main/docs/readme.md",
      downloadUrl: "https://raw.githubusercontent.com/org/repo-a/main/docs/readme.md",
    });
  });

  it("skips deprecated repositories excluded from org-wide checks", async () => {
    octokit.paginate.mockResolvedValue([
      ...repos,
      {
        full_name: "org/fingerprint-pro-segment-source-function",
        owner: { login: "org" },
        name: "fingerprint-pro-segment-source-function",
        archived: false,
      },
    ]);

    const readmes = await run(() => getReadmesFromOrg("org"));
    expect(readmes).toHaveLength(8);
    expect(
      readmes.some((readme) =>
        readme.sourcePath.includes("fingerprint-pro-segment-source-function"),
      ),
    ).toBe(false);
  });

  it("skips archived repositories", async () => {
    octokit.paginate.mockResolvedValue([
      ...repos,
      { full_name: "org/old", owner: { login: "org" }, name: "old", archived: true },
    ]);

    const readmes = await run(() => getReadmesFromOrg("org"));
    expect(readmes).toHaveLength(8);
    expect(readmes.some((readme) => readme.sourcePath.includes("/org/old/"))).toBe(false);
  });

  it("throws a clear error when the repositories cannot be listed", async () => {
    octokit.paginate.mockRejectedValue(new Error("Bad credentials"));
    await expect(run(() => getReadmesFromOrg("org"))).rejects.toMatchObject({
      name: "OrgListingError",
      message: "Failed to list repositories of GitHub organization org: Bad credentials",
    });
  });

  it("samples README files deterministically with LINK_CHECK_SAMPLE_RATE", async () => {
    vi.stubEnv("LINK_CHECK_SAMPLE_RATE", "0.25");
    const first = await run(() => getReadmesFromOrg("org"));
    octokit.paginate.mockResolvedValue(repos.toReversed());
    const second = await run(() => getReadmesFromOrg("org"));

    expect(first).toHaveLength(2);
    expect(second).toEqual(first);
  });
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

  it("returns the links of downloaded READMEs, resolved against the README page", async () => {
    const fetch = async () =>
      new Response("[abs](https://example.com/) [root](/docs/a.md) [sib](b.md)");

    const links = await run(() => getReadmeLinks([file("pkg")]), { fetch });

    const page = "https://github.com/org/repo/blob/main/pkg/README.md";
    expect(links).toEqual([
      { page, href: "https://example.com/", text: "abs" },
      { page, href: "https://github.com/org/repo/blob/main/docs/a.md", text: "root" },
      { page, href: "https://github.com/org/repo/blob/main/pkg/b.md", text: "sib" },
    ]);
  });

  it("skips READMEs that cannot be downloaded", async () => {
    const fetch = async (input: string | URL | Request) =>
      String(input).includes("/gone/")
        ? new Response("Not Found", { status: 404 })
        : new Response("[x](https://example.com/)");

    const links = await run(() => getReadmeLinks([file("gone"), file("ok")]), { fetch });

    expect(links.map((link) => link.page)).toEqual([file("ok").sourcePath]);
  });
});

// The GitHub client is created on first use, not on import (see `getGithubApi`)
it("importing GitHub link checks does not require GH_TOKEN", async () => {
  vi.stubEnv("GH_TOKEN", "");
  vi.resetModules();
  await expect(import("../check/github_api_check")).resolves.toBeDefined();
  await expect(import("./github_org")).resolves.toBeDefined();
});
