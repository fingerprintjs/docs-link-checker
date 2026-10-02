import { afterAll, describe, expect, it } from "vitest";
import { closeRunBrowser } from "../run";
import { checkLinkWithGithubApi } from "./gh_check_link";

// Checks outside of a run share one browser, close it when done
afterAll(closeRunBrowser);

describe("checkLinkWithGithubApi", () => {
  it("should handle GitHub issue links", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprintjs/issues/1",
    );
    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should handle non-existent GitHub issue links", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprintjs/issues/999999",
    );
    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "Issue #999999 not found in repository fingerprintjs/fingerprintjs",
    });
  });

  it("should handle GitHub blob links without hash", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprintjs/blob/master/readme.md",
    );
    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should handle GitHub blob links with valid hash", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprintjs/blob/master/readme.md#demo",
    );
    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should handle GitHub blob links with invalid hash", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprintjs/blob/master/readme.md#nonexistent-heading",
    );
    expect(result).toMatchObject({
      ok: false,
      error: "hash not found",
      status: 200,
      errorDetail: "No heading found matching hash: nonexistent-heading",
    });
  });

  it("should handle non-existent GitHub blob links", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprintjs/blob/master/nonexistent.md",
    );
    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "File not found in repository",
    });
  });

  it("should return error for unexpected link types", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprintjs/unknown/path",
    );
    expect(result).toMatchObject({
      ok: false,
      error: "unexpected error",
      status: 400,
      errorDetail: "Unknown link type: unknown/path",
    });
  });

  it("should handle GitHub discussion links", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprintjs/discussions/916",
    );
    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should handle non-existent GitHub discussion links", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprintjs/discussions/999999",
    );
    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
    });
  });

  it("should handle GitHub branch links", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprintjs/tree/master",
    );
    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should handle non-existent GitHub branch links", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprintjs/tree/nonexistent-branch",
    );
    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
    });
  });

  it("should handle GitHub pull request links", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprintjs/pull/1094",
    );
    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should handle non-existent GitHub pull request links", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprintjs/pull/999999",
    );
    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
    });
  });

  it("should handle GitHub release links", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprintjs/releases/tag/v3.0.0",
    );
    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should handle non-existent GitHub release links", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprintjs/releases/tag/nonexistent-tag",
    );
    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
    });
  });

  it("should handle folder links", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprintjs/tree/master/src",
    );
    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should handle non-existent folder links", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprintjs/tree/master/nonexistent",
    );
    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
    });
  });

  it("should handle links to discussions section", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprintjs/discussions",
    );
    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should handle links to releases section", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprintjs/releases",
    );
    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should handle links to pull requests section", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprintjs/pulls",
    );
    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should handle links to issues section", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprintjs/issues",
    );
    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should handle links to repository root", async () => {
    const result = await checkLinkWithGithubApi("https://github.com/fingerprintjs/fingerprintjs");
    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should handle links to repository root with trailing slash", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprint-pro-server-api-dotnet-sdk/",
    );
    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should handle blob folders", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprintjs-pro-react/blob/main/examples",
    );
    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should handle link to wiki", async () => {
    const result = await checkLinkWithGithubApi("https://github.com/fingerprintjs/home/wiki");
    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should handle link to specific wiki article", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/home/wiki/FingerprintJS-Naming-Conventions",
    );
    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should handle hash with incorrect case", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprint-pro-server-api-java-sdk/blob/main/docs/FingerprintApi.md#gEtEvEnT",
    );
    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should link to create new issue", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprintjs/issues/new",
    );
    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should return error for non-existent wiki", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/nonexistent-repo/wiki",
    );
    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
    });
  });

  it("should handle link to release artifact", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprintjs-android/releases/download/2.2.0/Playground-release-2.2.0.apk",
    );
    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should handle code line hashes like #L5", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprintjs/blob/master/package.json#L5",
    );
    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should handle code line span hashes like #L5-L10", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprintjs/blob/master/package.json#L5-L10",
    );
    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should report code line hashes past the end of the file as 'hash not found'", async () => {
    for (const hash of ["#L99999", "#L8888-L9999"]) {
      const result = await checkLinkWithGithubApi(
        `https://github.com/fingerprintjs/fingerprintjs/blob/master/package.json${hash}`,
      );
      expect(result).toMatchObject({
        ok: false,
        error: "hash not found",
        status: 200,
        errorDetail: expect.stringMatching(/^package\.json has only \d+ lines$/),
      });
    }
  });

  it("should handle commit links", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/WebKit/WebKit/commit/6f2b47e87bc414001affb258048749130bc91083",
    );
    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should handle repository root with query parameters", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprintjs?tab=readme-ov-file",
    );
    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should handle repository root with branch query parameter", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprintjs/tree/master?ref=main",
    );
    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should handle repository root with trailing query parameters", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/fingerprintjs/?tab=readme-ov-file",
    );
    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should handle non-existent repository root", async () => {
    const result = await checkLinkWithGithubApi(
      "https://github.com/fingerprintjs/nonexistent-repo",
    );
    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
    });
  });
});
