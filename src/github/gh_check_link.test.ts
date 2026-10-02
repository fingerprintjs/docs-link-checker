import { beforeEach, describe, expect, it, vi } from "vitest";

// Fake Octokit: no network, records the parameters passed to every API call
const { octokit } = vi.hoisted(() => {
  const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });
  return {
    octokit: {
      notFound,
      users: { getByUsername: vi.fn() },
      repos: {
        get: vi.fn(),
        getReleaseByTag: vi.fn(),
        getContent: vi.fn(),
        getCommit: vi.fn(),
      },
      git: { getRef: vi.fn(), getCommit: vi.fn() },
    },
  };
});

vi.mock("./github_client", () => ({ getMyOctokit: () => octokit }));

import { checkLinkWithGithubApi, isGithubCodeLineLink, isGithubUrl } from "./gh_check_link";
import { decodePathSegment, getGithubPathSegments, isGithubReservedRoute } from "./gh_url";

beforeEach(() => {
  for (const fn of [
    octokit.users.getByUsername,
    octokit.repos.get,
    octokit.repos.getReleaseByTag,
    octokit.repos.getContent,
    octokit.repos.getCommit,
    octokit.git.getRef,
    octokit.git.getCommit,
  ]) {
    fn.mockReset();
    fn.mockResolvedValue({ data: {} });
  }
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
  });
});

describe("checkLinkWithGithubApi", () => {
  it("should throw error for non-GitHub URLs", async () => {
    await expect(checkLinkWithGithubApi("https://example.com")).rejects.toThrow("Not a GitHub URL");
  });
});

describe("decodePathSegment() / getGithubPathSegments()", () => {
  it("decodes percent-encoded segments", () => {
    expect(decodePathSegment("%40fingerprint%2Fvue%402.0.0")).toBe("@fingerprint/vue@2.0.0");
    expect(decodePathSegment("my%20file.md")).toBe("my file.md");
  });

  it("keeps malformed percent-encoding as is (does not throw)", () => {
    expect(decodePathSegment("100%")).toBe("100%");
    expect(decodePathSegment("%E0%A4%A")).toBe("%E0%A4%A");
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

describe("checkLinkWithGithubApi() with GitHub's own pages", () => {
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

  it.each([
    "https://github.com/features",
    "https://github.com/marketplace",
    "https://github.com/topics/javascript",
    "https://github.com/pricing/",
  ])("checks %s as a page, not as an account or a repository", async (url) => {
    const result = await checkLinkWithGithubApi(url);

    expect(result).toEqual({ ok: true, status: 200 });
    expect(String(fetchMock.mock.calls[0]![0])).toBe(url);
    expect(octokit.users.getByUsername).not.toHaveBeenCalled();
    expect(octokit.repos.get).not.toHaveBeenCalled();
  });

  it("reports a missing GitHub page as broken link", async () => {
    fetchMock.mockImplementation(async () => new Response("Not found", { status: 404 }));

    const result = await checkLinkWithGithubApi("https://github.com/topics/no-such-topic-xyz");

    expect(result).toMatchObject({ ok: false, error: "broken link", status: 404 });
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
