import { beforeEach, describe, expect, it, vi } from "vitest";

// Fake Octokit: no network, records the parameters passed to every API call
const { octokit } = vi.hoisted(() => {
  const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });
  return {
    octokit: {
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
      // All pages of a list endpoint: the mocks return a single page
      paginate: async (fn: (params: unknown) => Promise<{ data: unknown[] }>, params: unknown) =>
        (await fn(params)).data,
    },
  };
});

vi.mock("./github_client", () => ({
  getMyOctokit: () => {
    if (octokit.noToken) {
      throw new Error("GH_TOKEN is not set. A GitHub token is required to check GitHub links.");
    }
    return octokit;
  },
}));

import { checkLinkWithGithubApi } from "./gh_check_link";
import {
  getGithubPathSegments,
  isGithubCodeLineLink,
  isGithubReservedRoute,
  isGithubUrl,
  safeDecode,
} from "./gh_url";

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

describe("isGithubUrl", () => {
  it("should return true for github.com URLs", () => {
    expect(isGithubUrl("https://github.com/owner/repo")).toBe(true);
  });

  it("should return false for non-github.com URLs", () => {
    expect(isGithubUrl("https://example.com")).toBe(false);
    expect(isGithubUrl("https://gitlab.com/owner/repo")).toBe(false);
    expect(isGithubUrl("https://docs.github.com/en/codespaces")).toBe(false);
    expect(isGithubUrl("https://gist.github.com/t3dotgg/a486c4ae66d32bf17c09c73609dacc5b")).toBe(
      false,
    );
  });
});

describe("isGithubCodeLineLink", () => {
  it("should return true for valid code line links", () => {
    expect(isGithubCodeLineLink("https://github.com/owner/repo/blob/main/file.js#L5")).toBe(true);
    expect(isGithubCodeLineLink("https://github.com/owner/repo/blob/main/file.js#L5-L10")).toBe(
      true,
    );
  });

  it("should recognize percent-encoded code line links", () => {
    expect(isGithubCodeLineLink("https://github.com/owner/repo/blob/main/file.js#%4C12")).toBe(
      true,
    );
    expect(isGithubCodeLineLink("https://github.com/owner/repo/blob/main/file.js#L12%2DL20")).toBe(
      true,
    );
    // Malformed percent-encoding is not a line link (and does not throw)
    expect(isGithubCodeLineLink("https://github.com/owner/repo/blob/main/file.js#L12%")).toBe(
      false,
    );
  });

  it("should return false for invalid code line links", () => {
    expect(isGithubCodeLineLink("https://github.com/owner/repo/blob/main/file.js#L")).toBe(false);
    expect(isGithubCodeLineLink("https://github.com/owner/repo/blob/main/file.js#L5-")).toBe(false);
    expect(isGithubCodeLineLink("https://github.com/owner/repo/blob/main/file.js#L-L10")).toBe(
      false,
    );
    expect(isGithubCodeLineLink("https://github.com/owner/repo/blob/main/file.js#L5-L10-L15")).toBe(
      false,
    );
    expect(isGithubCodeLineLink("https://github.com/owner/repo/blob/main/file.js#L5C")).toBe(false);
    expect(isGithubCodeLineLink("https://github.com/owner/repo/blob/main/file.js#l5")).toBe(false);
  });

  it("should return true for code line links with columns (same grammar as `parseLineAnchor`)", () => {
    for (const hash of ["#L2C5", "#L2C5-L3C1", "#L2-L3C1", "#L2C5-L3", "#L2C5%2DL3C1"]) {
      expect(isGithubCodeLineLink(`https://github.com/owner/repo/blob/main/file.js${hash}`)).toBe(
        true,
      );
    }
  });
});

describe("safeDecode() / getGithubPathSegments()", () => {
  it("decodes percent-encoded segments", () => {
    expect(safeDecode("%40fingerprint%2Fvue%402.0.0")).toBe("@fingerprint/vue@2.0.0");
    expect(safeDecode("my%20file.md")).toBe("my file.md");
  });

  it("keeps malformed percent-encoding as is (does not throw)", () => {
    expect(safeDecode("100%")).toBe("100%");
    expect(safeDecode("%E0%A4%A")).toBe("%E0%A4%A");
  });

  it("splits before decoding, so an encoded slash stays in its segment", () => {
    expect(
      getGithubPathSegments(new URL("https://github.com/o/r/releases/tag/%40scope%2Fpkg%401.0.0/")),
    ).toEqual(["o", "r", "releases", "tag", "@scope/pkg@1.0.0"]);
  });
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
    });
  });

  it("accepts a release tag with an unencoded slash", async () => {
    await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/vue/releases/tag/@fingerprint/vue@2.0.0",
    );

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
    await checkLinkWithGithubApi("https://github.com/o/r/blob/main/docs/my%20file%40v1.md");

    expect(octokit.repos.getContent).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      ref: "main",
      path: "docs/my file@v1.md",
    });
  });

  it("passes a decoded tree path", async () => {
    await checkLinkWithGithubApi("https://github.com/o/r/tree/v1.0/src/%5Bid%5D");

    expect(octokit.repos.getContent).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      ref: "v1.0",
      path: "src/[id]",
    });
  });

  it("passes a decoded commit ref", async () => {
    await checkLinkWithGithubApi("https://github.com/o/r/commit/abc%31234");

    expect(octokit.repos.getCommit).toHaveBeenCalledWith({ owner: "o", repo: "r", ref: "abc1234" });
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
    expect(octokit.users.getByUsername).toHaveBeenCalledWith({ username });
    expect(octokit.repos.get).not.toHaveBeenCalled();
  });

  it("reports a missing account as broken link", async () => {
    octokit.users.getByUsername.mockRejectedValue(octokit.notFound());
    // The page itself is checked too (it could be one of GitHub's own pages), it is missing as well
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Not found", { status: 404 })),
    );

    const result = await checkLinkWithGithubApi("https://github.com/no-such-org-xyz");

    expect(result).toEqual({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "User or organization no-such-org-xyz not found",
    });
  });

  it("reports other API errors as unexpected errors (re-checked with Playwright)", async () => {
    octokit.users.getByUsername.mockRejectedValue(
      Object.assign(new Error("Server Error"), { status: 502 }),
    );

    const result = await checkLinkWithGithubApi("https://github.com/frida");

    expect(result).toMatchObject({ ok: false, error: "unexpected error" });
  });

  it("still checks repository URLs as repositories", async () => {
    const result = await checkLinkWithGithubApi("https://github.com/frida/frida/");

    expect(result).toEqual({ ok: true, status: 200 });
    expect(octokit.repos.get).toHaveBeenCalledWith({ owner: "frida", repo: "frida" });
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

describe("isGithubReservedRoute()", () => {
  it.each([
    "https://github.com/features",
    "https://github.com/features/actions",
    "https://github.com/marketplace/actions/checkout",
    "https://github.com/topics/javascript",
    "https://github.com/Explore",
    "https://github.com/sponsors/someone",
    "https://github.com/orgs/fingerprintjs/people",
    "https://github.com/settings/tokens",
  ])("detects %s", (url) => {
    expect(isGithubReservedRoute(url)).toBe(true);
  });

  it.each([
    "https://github.com/",
    "https://github.com/fingerprintjs",
    "https://github.com/fingerprintjs/features",
    "https://github.com/featuresx",
    "https://gist.github.com/features",
  ])("does not detect %s", (url) => {
    expect(isGithubReservedRoute(url)).toBe(false);
  });
});

describe("checkLinkWithGithubApi() with unknown account URLs", () => {
  const fetchMock =
    vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(
      async () => new Response("<html><body></body></html>", { status: 200 }),
    );
    // Restored after every test (`unstubGlobals`)
    vi.stubGlobal("fetch", fetchMock);
  });

  it("accepts an unknown account URL whose page exists (a GitHub page missing from the reserved routes)", async () => {
    octokit.users.getByUsername.mockRejectedValue(octokit.notFound());

    const result = await checkLinkWithGithubApi("https://github.com/premium-support");

    expect(result).toEqual({ ok: true, status: 200 });
    expect(octokit.users.getByUsername).toHaveBeenCalledWith({ username: "premium-support" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports the API 404 when the page of an unknown account does not work either", async () => {
    octokit.users.getByUsername.mockRejectedValue(octokit.notFound());
    fetchMock.mockImplementation(async () => new Response("Too many requests", { status: 429 }));

    const result = await checkLinkWithGithubApi("https://github.com/no-such-org-xyz");

    expect(result).toEqual({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "User or organization no-such-org-xyz not found",
    });
  });

  it("does not fetch the page of an existing account", async () => {
    await checkLinkWithGithubApi("https://github.com/fingerprintjs");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GitHub API server errors", () => {
  const serverError = (status: number) =>
    Object.assign(new Error("Service Unavailable"), { status });

  it("reports a repository check failing with a 5xx (after Octokit's retries) as unexpected error, not broken", async () => {
    octokit.repos.get.mockRejectedValue(serverError(503));

    const result = await checkLinkWithGithubApi("https://github.com/owner/busy-repo");

    // Unexpected errors from the API are re-checked with Playwright (see `shouldRecheckWithPlaywright`)
    expect(result).toMatchObject({ ok: false, error: "unexpected error", status: 503 });
  });

  it("still reports a missing repository as broken", async () => {
    octokit.repos.get.mockRejectedValue(octokit.notFound());

    const result = await checkLinkWithGithubApi("https://github.com/owner/missing-repo");

    expect(result).toMatchObject({ ok: false, error: "broken link", status: 404 });
  });

  it("reports a tree check failing with a 5xx as unexpected error, not broken", async () => {
    octokit.repos.getContent.mockRejectedValue(serverError(502));

    const result = await checkLinkWithGithubApi("https://github.com/o/r/tree/some-branch");

    expect(result).toMatchObject({ ok: false, error: "unexpected error", status: 502 });
  });

  it("still reports a missing branch or commit as broken", async () => {
    octokit.repos.getContent.mockRejectedValue(octokit.notFound());

    const result = await checkLinkWithGithubApi("https://github.com/o/r/tree/missing");

    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "No branch, tag or commit missing found in repository o/r",
    });
  });
});

describe("GitHub API 401 and 403 (bad token, rate limits after Octokit's retry, no access)", () => {
  const apiError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

  it.each([401, 403])(
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

  it("reports a 403 of a tree link as unexpected error", async () => {
    octokit.repos.getContent.mockRejectedValue(apiError(403));

    const result = await checkLinkWithGithubApi("https://github.com/o/r/tree/some-branch");

    expect(result).toMatchObject({ ok: false, error: "unexpected error", status: 403 });
  });

  it("reports a deleted issue (410 Gone) as broken link", async () => {
    octokit.issues.get.mockRejectedValue(apiError(410));

    const result = await checkLinkWithGithubApi("https://github.com/o/r/issues/1");

    expect(result).toMatchObject({ ok: false, error: "broken link", status: 410 });
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

  it("checks the line against the file from the API (no browser)", async () => {
    octokit.repos.getContent.mockResolvedValue(fileContent('{\n  "name": "x"\n}\n'));

    expect(
      await checkLinkWithGithubApi("https://github.com/o/r/blob/main/package.json#L3"),
    ).toEqual({ ok: true, status: 200 });
    expect(
      await checkLinkWithGithubApi("https://github.com/o/r/blob/main/package.json#L2-L4"),
    ).toMatchObject({
      ok: false,
      error: "hash not found",
      errorDetail: "package.json has only 3 lines",
    });
    expect(octokit.repos.getContent).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      ref: "main",
      path: "package.json",
    });
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
