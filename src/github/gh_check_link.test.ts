import { describe, expect, it } from "vitest";
import { checkLinkWithGithubApi, isGithubCodeLineLink, isGithubUrl } from "./gh_check_link";

describe("isGithubUrl", () => {
  it("should return true for github.com URLs", () => {
    expect(isGithubUrl("https://github.com/owner/repo")).toBe(true);
  });

  it("should return false for non-github.com URLs", () => {
    expect(isGithubUrl("https://example.com")).toBe(false);
    expect(isGithubUrl("https://gitlab.com/owner/repo")).toBe(false);
    expect(isGithubUrl("https://docs.github.com/en/codespaces")).toBe(false);
    expect(isGithubUrl("https://gist.github.com/t3dotgg/a486c4ae66d32bf17c09c73609dacc5b")).toBe(
      false
    );
  });
});

describe("isGithubCodeLineLink", () => {
  it("should return true for valid code line links", () => {
    expect(isGithubCodeLineLink("https://github.com/owner/repo/blob/main/file.js#L5")).toBe(true);
    expect(isGithubCodeLineLink("https://github.com/owner/repo/blob/main/file.js#L5-L10")).toBe(
      true
    );
  });

  it("should recognize percent-encoded code line links", () => {
    expect(isGithubCodeLineLink("https://github.com/owner/repo/blob/main/file.js#%4C12")).toBe(true);
    expect(isGithubCodeLineLink("https://github.com/owner/repo/blob/main/file.js#L12%2DL20")).toBe(true);
    // Malformed percent-encoding is not a line link (and does not throw)
    expect(isGithubCodeLineLink("https://github.com/owner/repo/blob/main/file.js#L12%")).toBe(false);
  });

  it("should return false for invalid code line links", () => {
    expect(isGithubCodeLineLink("https://github.com/owner/repo/blob/main/file.js#L")).toBe(false);
    expect(isGithubCodeLineLink("https://github.com/owner/repo/blob/main/file.js#L5-")).toBe(false);
    expect(isGithubCodeLineLink("https://github.com/owner/repo/blob/main/file.js#L-L10")).toBe(
      false
    );
    expect(isGithubCodeLineLink("https://github.com/owner/repo/blob/main/file.js#L5-L10-L15")).toBe(
      false
    );
  });
});

describe("checkLinkWithGithubApi", () => {
  it("should throw error for non-GitHub URLs", async () => {
    await expect(checkLinkWithGithubApi("https://example.com")).rejects.toThrow("Not a GitHub URL");
  });
});
