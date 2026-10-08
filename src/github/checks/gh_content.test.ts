// Skeleton: the titles of main's tests, to port with the new design (STEP 2, GITHUB group).
import { describe, it } from "vitest";

describe("checkLinkWithGithubApi() with blob links (mocked GitHub API)", () => {
  describe("heading hashes", () => {
    it.todo("returns OK for %s");
    it.todo("returns 'hash not found' for code block comments");
    it.todo("decodes percent-encoded hashes");
    it.todo("accepts a directory without hash");
  });
  describe("code line hashes", () => {
    it.todo("accepts %s within the file");
    it.todo("reports %s past the end of the file as 'hash not found'");
    it.todo("reports an invalid line anchor as 'hash not found'");
    it.todo("reads files over 1 MB with the blob API (no content in the contents API)");
    it.todo("reports line anchors on binary files as 'hash not found'");
    it.todo("reports line anchors on directories as 'hash not found'");
    it.todo("reports a missing file (or private repository) as broken link");
    it.todo("reports a %s as 'unexpected error' (re-checked in the browser)");
    it.todo("reports a failing blob API request (large file) as 'unexpected error'");
    it.todo("resolves branch names with slashes (`feature/x`)");
    it.todo(
      "resolves branch names of any length (5 segments) with one listing of branches and tags",
    );
    it.todo("resolves tag names with slashes (`@scope/pkg@1.0.0`)");
    it.todo(
      "tries a shorter ref if the longest one has no such file (a branch `a/b` and a tag `a/b/c`)",
    );
    it.todo("reports a nonexistent ref as broken link, a ref is never the whole path");
    it.todo("reports a missing repository (no refs listed) as broken link");
    it.todo("does not try longer refs after an error that is not 'not found'");
    it.todo("reports a failing ref listing as 'unexpected error', not broken");
    it.todo(
      "checks line anchors on rendered markdown against the lines, a heading `L12` matches too",
    );
  });
});
