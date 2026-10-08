import { describe, expect, it } from "vitest";
import { createBaseline, updateBaseline } from "./baseline";
import { getJSONReport } from "./report/report";
import type { LinkWithResult } from "./types";

const broken = (href: string, page = "https://example.com/page"): LinkWithResult => ({
  href,
  page,
  text: "text",
  result: { ok: false, error: "broken link", status: 404 },
});

// TODO(STEP 2, CLI group): port these tests
describe("loadBaseline() validation", () => {
  it.todo("accepts an object with `ignore`, a bare array and string shorthands");
  it.todo("rejects %j");
});

describe("createBaseline().findEntry()", () => {
  const baseline = createBaseline([
    { href: "https://exact.com/a", reason: "exact" },
    { href: "https://on-page.com/a", page: "docs/guide.md", reason: "on page" },
    { pattern: "https://glob.com/**", reason: "glob" },
    { pattern: "https://(a+)+$.com/*", reason: "metacharacters" },
    { pattern: "https://page-glob.com/*", page: "docs/**" },
  ]);

  it("matches exact hrefs only", () => {
    expect(baseline.findEntry(broken("https://exact.com/a"))?.reason).toBe("exact");
    expect(baseline.findEntry(broken("https://exact.com/a/b"))).toBeUndefined();
    expect(baseline.findEntry(broken("https://exact.com/"))).toBeUndefined();
  });

  it("restricts entries with `page` to that page", () => {
    expect(baseline.findEntry(broken("https://on-page.com/a", "docs/guide.md"))?.reason).toBe(
      "on page",
    );
    expect(baseline.findEntry(broken("https://on-page.com/a", "docs/other.md"))).toBeUndefined();
    expect(baseline.findEntry(broken("https://page-glob.com/x", "docs/a/b.md"))).toBeDefined();
    expect(baseline.findEntry(broken("https://page-glob.com/x", "README.md"))).toBeUndefined();
  });

  it("matches globs, regular expression characters are literal", () => {
    expect(baseline.findEntry(broken("https://glob.com/any/path?q=1"))?.reason).toBe("glob");
    expect(baseline.findEntry(broken("https://(a+)+$.com/x"))?.reason).toBe("metacharacters");
    expect(baseline.findEntry(broken("https://aaa.com/x"))).toBeUndefined();
    expect(baseline.findEntry(broken("https://other.com/glob.com/"))).toBeUndefined();
  });

  it("matches the bare origin with an `<origin>/**` pattern (with or without trailing slash)", () => {
    expect(baseline.findEntry(broken("https://glob.com"))?.reason).toBe("glob");
    expect(baseline.findEntry(broken("https://glob.com/"))?.reason).toBe("glob");
    expect(baseline.findEntry(broken("https://glob.community"))).toBeUndefined();
  });
});

describe("getJSONReport() with a baseline", () => {
  const baseline = createBaseline([
    { href: "https://ignored.com/", reason: "known issue" },
    { pattern: "https://ok.com/**" },
    { pattern: "https://error.com/**" },
  ]);
  const report = getJSONReport({
    siteName: "test",
    baseline,
    links: [
      broken("https://ignored.com/"),
      broken("https://broken.com/"),
      // Matches a pattern on purpose: successful links are never ignored
      { href: "https://ok.com/", page: "p", text: "t", result: { ok: true, status: 200 } },
      {
        href: "https://ok.com/hash#x",
        page: "p",
        text: "t",
        result: { ok: false, error: "could not check", status: 403 },
      },
      // A check that threw (see `checkLinks`): reported as an "unexpected error" result, like any other failure
      {
        href: "https://error.com/x",
        page: "p",
        text: "t",
        result: { ok: false, error: "unexpected error", errorDetail: "boom" },
      },
    ],
  });

  it("moves matching failures to `ignored` with the reason, they don't count towards links to fix", () => {
    expect(report.summary).toEqual({
      linksChecked: 5,
      totalLinksToFix: 1,
      brokenLinks: 1,
      hashNotFound: 0,
      networkErrors: 0,
      couldNotCheck: 0,
      ignored: 3,
    });
    expect(report.brokenLinks.map((link) => link.href)).toEqual(["https://broken.com/"]);
    expect(report.ignored.map((link) => [link.href, link.ignoreReason])).toEqual([
      ["https://ignored.com/", "known issue"],
      ["https://ok.com/hash#x", undefined],
      ["https://error.com/x", undefined],
    ]);
  });
});

// TODO(STEP 2, CLI group): port these tests
describe("loadBaseline()", () => {
  it.todo("loads a valid file");
  it.todo("loads the repository baseline file");
  it.todo("reports missing files, unless allowed");
  it.todo("reports invalid JSON and invalid entries with the file name");
});

describe("updateBaseline()", () => {
  const baseline = createBaseline([
    { href: "https://still-broken.com/", reason: "keep my reason" },
    { href: "https://fixed.com/" },
    { pattern: "https://unused-pattern.com/**" },
  ]);
  const failures = [
    broken("https://still-broken.com/"),
    broken("https://new-b.com/", "b.md"),
    broken("https://new-a.com/", "a.md"),
    broken("https://new-a.com/", "a.md"),
  ];

  it("by default keeps every entry (partial runs) and adds new failures (sorted, deduplicated)", () => {
    expect(updateBaseline({ baseline, failures })).toEqual({
      ignore: [
        { href: "https://still-broken.com/", reason: "keep my reason" },
        { href: "https://fixed.com/" },
        { pattern: "https://unused-pattern.com/**" },
        { href: "https://new-a.com/", page: "a.md" },
        { href: "https://new-b.com/", page: "b.md" },
      ],
    });
  });

  it("with `prune`, drops exact entries that no longer fail, keeps patterns", () => {
    expect(updateBaseline({ baseline, failures, prune: true })).toEqual({
      ignore: [
        { href: "https://still-broken.com/", reason: "keep my reason" },
        { pattern: "https://unused-pattern.com/**" },
        { href: "https://new-a.com/", page: "a.md" },
        { href: "https://new-b.com/", page: "b.md" },
      ],
    });
  });

  it("adds a reason to new entries", () => {
    const { ignore } = updateBaseline({ baseline, failures, reason: "why" });
    expect(ignore).toContainEqual({ href: "https://new-a.com/", page: "a.md", reason: "why" });
  });

  it("keeps exact entries that still match even when an earlier broad pattern matches first", () => {
    const overlapping = createBaseline([
      { pattern: "https://broad.com/**", reason: "broad" },
      { href: "https://broad.com/still-broken", page: "a.md", reason: "specific" },
      { href: "https://broad.com/fixed", page: "a.md" },
    ]);
    expect(
      updateBaseline({
        baseline: overlapping,
        failures: [broken("https://broad.com/still-broken", "a.md")],
        prune: true,
      }),
    ).toEqual({
      ignore: [
        { pattern: "https://broad.com/**", reason: "broad" },
        { href: "https://broad.com/still-broken", page: "a.md", reason: "specific" },
      ],
    });
  });

  it.todo("writes a file that loads back");
});
