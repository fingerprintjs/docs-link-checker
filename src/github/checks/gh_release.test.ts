import { expect, describe, it } from "vitest";
import { checkGitHubReleaseLink } from "./gh_release";

describe("checkGitHubReleaseLink", () => {
  it("should return success for latest release when releases exist", async () => {
    const url = new URL("https://github.com/fingerprintjs/fingerprintjs/releases/latest");
    const result = await checkGitHubReleaseLink(url, "fingerprintjs", "fingerprintjs", [
      "releases",
      "latest",
    ]);

    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should return error for latest release when no releases exist", async () => {
    const url = new URL("https://github.com/fingerprintjs/fingerprintjs/releases/latest");
    const result = await checkGitHubReleaseLink(url, "fingerprintjs", "nonexistent-repo", [
      "releases",
      "latest",
    ]);

    expect(result).toMatchObject({
      ok: false,
      error: "unexpected error",
      status: 500,
    });
  });

  it("should return success for a valid release tag", async () => {
    const url = new URL("https://github.com/fingerprintjs/fingerprintjs/releases/tag/v3.0.0");
    const result = await checkGitHubReleaseLink(url, "fingerprintjs", "fingerprintjs", [
      "releases",
      "tag",
      "v3.0.0",
    ]);

    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should return error for an invalid release tag", async () => {
    const url = new URL(
      "https://github.com/fingerprintjs/fingerprintjs/releases/tag/nonexistent-tag"
    );
    const result = await checkGitHubReleaseLink(url, "fingerprintjs", "fingerprintjs", [
      "releases",
      "tag",
      "nonexistent-tag",
    ]);

    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail:
        "Release tag nonexistent-tag not found in repository fingerprintjs/fingerprintjs",
    });
  });

  it("should return error for invalid release URL format", async () => {
    const url = new URL("https://github.com/fingerprintjs/fingerprintjs/releases/invalid");
    const result = await checkGitHubReleaseLink(url, "fingerprintjs", "fingerprintjs", [
      "releases",
      "invalid",
    ]);

    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "Invalid release URL format",
    });
  });
});
