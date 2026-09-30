import { describe, expect, it } from "vitest";
import { checkGitHubBlobLink } from "./gh_blob";

describe("checkGitHubBlobLink", () => {
  it("should return success for an existing file without hash", async () => {
    const url = new URL("https://github.com/fingerprintjs/fingerprintjs/blob/master/readme.md");
    const result = await checkGitHubBlobLink(url, "fingerprintjs", "fingerprintjs", [
      "blob",
      "master",
      "readme.md",
    ]);

    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should return success for an existing file with valid hash", async () => {
    const url = new URL(
      "https://github.com/fingerprintjs/fingerprintjs/blob/master/readme.md#demo",
    );
    const result = await checkGitHubBlobLink(url, "fingerprintjs", "fingerprintjs", [
      "blob",
      "master",
      "readme.md",
    ]);

    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should return error for an existing file with invalid hash", async () => {
    const url = new URL(
      "https://github.com/fingerprintjs/fingerprintjs/blob/master/readme.md#nonexistent-heading",
    );
    const result = await checkGitHubBlobLink(url, "fingerprintjs", "fingerprintjs", [
      "blob",
      "master",
      "readme.md",
    ]);

    expect(result).toMatchObject({
      ok: false,
      error: "hash not found",
      status: 200,
      errorDetail: "No heading found matching hash: nonexistent-heading",
    });
  });

  it("should return error for a non-existent file", async () => {
    const url = new URL(
      "https://github.com/fingerprintjs/fingerprintjs/blob/master/nonexistent.md",
    );
    const result = await checkGitHubBlobLink(url, "fingerprintjs", "fingerprintjs", [
      "blob",
      "master",
      "nonexistent.md",
    ]);

    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "File not found in repository",
    });
  });
});
