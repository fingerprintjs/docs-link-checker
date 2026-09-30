import { describe, expect, it } from "vitest";
import { checkGitHubReleaseLink } from "./gh_release";

describe("checkGitHubReleaseLink", () => {
  it("should return success for latest release when releases exist", async () => {
    const result = await checkGitHubReleaseLink("fingerprintjs", "fingerprintjs", [
      "releases",
      "latest",
    ]);

    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should return error for latest release when no releases exist", async () => {
    const result = await checkGitHubReleaseLink("fingerprintjs", "nonexistent-repo", [
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
    const result = await checkGitHubReleaseLink("fingerprintjs", "fingerprintjs", [
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
    const result = await checkGitHubReleaseLink("fingerprintjs", "fingerprintjs", [
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
    const result = await checkGitHubReleaseLink("fingerprintjs", "fingerprintjs", [
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

  it("should return error for non-existent release asset", async () => {
    const result = await checkGitHubReleaseLink("fingerprintjs", "fingerprintjs", [
      "releases",
      "download",
      "v3.0.0",
      "nonexistent-asset.js",
    ]);

    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail:
        "Asset nonexistent-asset.js not found in release v3.0.0 of repository fingerprintjs/fingerprintjs",
    });
  });

  it("should return error for invalid release ID format", async () => {
    const result = await checkGitHubReleaseLink("fingerprintjs", "fingerprintjs", [
      "releases",
      "invalid-id",
    ]);

    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "Invalid release URL format",
    });
  });
});
