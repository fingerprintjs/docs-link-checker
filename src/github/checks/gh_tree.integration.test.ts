import { describe, expect, it } from "vitest";
import { runWithGitHub } from "../test_utils";
import { checkGitHubTreeLink as checkGitHubTreeLinkEffect } from "./gh_content";

const checkGitHubTreeLink = (...args: Parameters<typeof checkGitHubTreeLinkEffect>) =>
  runWithGitHub(checkGitHubTreeLinkEffect(...args));

// Commit SHAs of a huge repository, the other `tree` links are checked in gh_check_link.integration.test.ts
const CHROMIUM_SHA = "3e914531a360b766bfd8468f59259b3ab29118d7";

describe("checkGitHubTreeLink", () => {
  it("accepts a commit SHA", async () => {
    const result = await checkGitHubTreeLink("chromium", "chromium", ["tree", CHROMIUM_SHA]);

    expect(result).toMatchObject({ ok: true, status: 200 });
  });

  it("accepts a path at a commit SHA", async () => {
    const result = await checkGitHubTreeLink("chromium", "chromium", [
      "tree",
      CHROMIUM_SHA,
      "third_party",
      "blink",
      "renderer",
      "platform",
      "audio",
      "cpu",
    ]);

    expect(result).toMatchObject({ ok: true, status: 200 });
  });
});
