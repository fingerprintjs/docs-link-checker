import { describe, expect, it } from "vitest";
import {
  getGithubPathSegments,
  isGithubCodeLineLink,
  isGithubReservedRoute,
  isGithubUrl,
  isGithubWikiLink,
  safeDecode,
} from "./gh_url";

describe("isGithubUrl()", () => {
  it("accepts github.com", () => {
    expect(isGithubUrl("https://github.com/owner/repo")).toBe(true);
  });

  it.each([
    "https://example.com",
    "https://gitlab.com/owner/repo",
    "https://docs.github.com/en/codespaces",
    "https://gist.github.com/t3dotgg/a486c4ae66d32bf17c09c73609dacc5b",
  ])("rejects %s", (url) => {
    expect(isGithubUrl(url)).toBe(false);
  });
});

describe("isGithubCodeLineLink()", () => {
  const file = "https://github.com/owner/repo/blob/main/file.js";

  it.each([
    "#L5",
    "#L5-L10",
    // Same grammar as `parseLineAnchor`: columns
    "#L2C5",
    "#L2C5-L3C1",
    "#L2-L3C1",
    "#L2C5-L3",
    // Percent-encoded
    "#%4C12",
    "#L12%2DL20",
    "#L2C5%2DL3C1",
  ])("accepts %s", (hash) => {
    expect(isGithubCodeLineLink(`${file}${hash}`)).toBe(true);
  });

  it.each([
    "#L",
    "#L5-",
    "#L-L10",
    "#L5-L10-L15",
    "#L5C",
    // Case-sensitive
    "#l5",
    // Malformed percent-encoding does not throw
    "#L12%",
  ])("rejects %s", (hash) => {
    expect(isGithubCodeLineLink(`${file}${hash}`)).toBe(false);
  });

  it("rejects line hashes of links that are not blobs", () => {
    expect(isGithubCodeLineLink("https://github.com/owner/repo/tree/main/dir#L5")).toBe(false);
  });
});

describe("safeDecode() / getGithubPathSegments()", () => {
  it("decodes percent-encoded segments", () => {
    expect(safeDecode("%40fingerprint%2Fvue%402.0.0")).toBe("@fingerprint/vue@2.0.0");
    expect(safeDecode("my%20file.md")).toBe("my file.md");
  });

  it.each(["100%", "%E0%A4%A"])("keeps malformed percent-encoding %s as is", (value) => {
    expect(safeDecode(value)).toBe(value);
  });

  it("splits before decoding, so an encoded slash stays in its segment", () => {
    expect(
      getGithubPathSegments(new URL("https://github.com/o/r/releases/tag/%40scope%2Fpkg%401.0.0/")),
    ).toEqual(["o", "r", "releases", "tag", "@scope/pkg@1.0.0"]);
  });
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

describe("isGithubWikiLink()", () => {
  it.each([
    ["https://github.com/owner/repo/wiki", true],
    ["https://github.com/owner/repo/wiki/Page", true],
    ["https://github.com/owner/repo/blob/main/wiki", false],
    ["https://github.com/wiki/repo", false],
    ["https://example.com/owner/repo/wiki", false],
  ])("%s -> %s", (url, expected) => {
    expect(isGithubWikiLink(url)).toBe(expected);
  });
});
