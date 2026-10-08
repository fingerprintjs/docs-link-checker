import { describe, expect, it } from "vitest";
import { checkGitHubTreeLink } from "./gh_content";

describe("checkGitHubTreeLink", () => {
  it("should return success for an existing branch without path", async () => {
    const result = await checkGitHubTreeLink("fingerprintjs", "fingerprintjs", ["tree", "master"]);

    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should return success for an existing branch with valid path", async () => {
    const result = await checkGitHubTreeLink("fingerprintjs", "fingerprintjs", [
      "tree",
      "master",
      "src",
    ]);

    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should return error for an existing branch with invalid path", async () => {
    const result = await checkGitHubTreeLink("fingerprintjs", "fingerprintjs", [
      "tree",
      "master",
      "nonexistent",
      "path",
    ]);

    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "Path nonexistent/path not found in branch, tag or commit master",
    });
  });

  it("should return error for a non-existent branch", async () => {
    const result = await checkGitHubTreeLink("fingerprintjs", "fingerprintjs", [
      "tree",
      "nonexistent-branch",
    ]);

    expect(result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail:
        "No branch, tag or commit nonexistent-branch found in repository fingerprintjs/fingerprintjs",
    });
  });

  it("should work for repositories with many many files", async () => {
    const result = await checkGitHubTreeLink("chromium", "chromium", [
      "tree",
      "3e914531a360b766bfd8468f59259b3ab29118d7",
      "third_party",
      "blink",
      "renderer",
      "platform",
      "audio",
      "cpu",
    ]);

    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should work for just branch, no path", async () => {
    const result = await checkGitHubTreeLink("fingerprintjs", "fingerprintjs", ["tree", "master"]);

    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it("should work for just commit, no path", async () => {
    const result = await checkGitHubTreeLink("chromium", "chromium", [
      "tree",
      "3e914531a360b766bfd8468f59259b3ab29118d7",
    ]);

    expect(result).toMatchObject({
      ok: true,
      status: 200,
    });
  });
});
