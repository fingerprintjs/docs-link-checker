import { describe, expect, it } from "vitest";
import { resolveReadmeHref } from "./gh_get_links";

// TODO(STEP 2, GITHUB group): port these tests
describe("getReadmesFromOrg()", () => {
  it.todo("lists README files of all repositories");
  it.todo("skips deprecated repositories excluded from org-wide checks");
  it.todo("skips archived repositories");
  it.todo("throws a clear error when the repositories cannot be listed");
  it.todo("samples README files deterministically with LINK_CHECK_SAMPLE_RATE");
});

describe("resolveReadmeHref()", () => {
  const page = "https://github.com/fingerprintjs/repository/blob/main/folder/README.md";

  it.each([
    ["https://other.com", "https://other.com"],
    ["#section", `${page}#section`],
    ["/nested/folder", "https://github.com/fingerprintjs/repository/blob/main/nested/folder"],
    ["/nested/file.md", "https://github.com/fingerprintjs/repository/blob/main/nested/file.md"],
    ["../sibling.md", "https://github.com/fingerprintjs/repository/blob/main/sibling.md"],
    ["sibling.md", "https://github.com/fingerprintjs/repository/blob/main/folder/sibling.md"],
  ])("resolves %s to %s", (href, expected) => {
    expect(resolveReadmeHref(href, page)).toBe(expected);
  });
});

// TODO(STEP 2, GITHUB group): port these tests
describe("getReadmeLinks()", () => {
  it.todo("returns the links of downloaded READMEs, resolved against the README page");
  it.todo("skips READMEs that cannot be downloaded");
});
