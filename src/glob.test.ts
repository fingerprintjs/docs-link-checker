import { describe, expect, it } from "vitest";
import { createGlobMatcher, parseGlob } from "./glob";

const matchGlob = (glob: string, text: string): boolean => createGlobMatcher(glob)(text);

describe("parseGlob()", () => {
  it("splits literals and wildcards, runs of 2+ stars are one globstar", () => {
    expect(parseGlob("a*b**c***d")).toEqual([
      { type: "literal", value: "a" },
      { type: "star" },
      { type: "literal", value: "b" },
      { type: "globstar" },
      { type: "literal", value: "c" },
      { type: "globstar" },
      { type: "literal", value: "d" },
    ]);
    expect(parseGlob("")).toEqual([]);
  });
});

describe("createGlobMatcher()", () => {
  it("matches the whole text literally without wildcards", () => {
    expect(matchGlob("https://example.com/a", "https://example.com/a")).toBe(true);
    expect(matchGlob("https://example.com/a", "https://example.com/a/b")).toBe(false);
    expect(matchGlob("https://example.com/a", "xhttps://example.com/a")).toBe(false);
    expect(matchGlob("", "")).toBe(true);
    expect(matchGlob("", "a")).toBe(false);
  });

  it.each([
    ["https://example.com/a?b=(1)+[2]", "https://example.com/aXb=(1)+[2]"],
    ["(a+)+$", "aaaa"],
    ["^a.b|c\\d{2}[x-z]", "ab"],
    ["a?b", "ab"],
    ["a?b", "aXb"],
    ["a.b", "aXb"],
    ["[ab]", "a"],
  ])("treats regular expression characters in %s literally", (glob, otherText) => {
    expect(matchGlob(glob, glob)).toBe(true);
    expect(matchGlob(glob, otherText)).toBe(false);
  });

  it("`*` does not match `/`, `**` matches anything", () => {
    expect(matchGlob("https://x.com/*", "https://x.com/user")).toBe(true);
    expect(matchGlob("https://x.com/*", "https://x.com/")).toBe(true);
    expect(matchGlob("https://x.com/*", "https://x.com/user/status/1")).toBe(false);
    expect(matchGlob("https://x.com/**", "https://x.com/user/status/1")).toBe(true);
    expect(matchGlob("docs/**/*.md", "docs/a/b/c.md")).toBe(true);
    expect(matchGlob("docs/**/*.md", "docs/a/b/c.txt")).toBe(false);
    expect(matchGlob("**.linkedin.com/**", "https://www.linkedin.com/company/x")).toBe(true);
    expect(matchGlob("*", "")).toBe(true);
    expect(matchGlob("a*a*a", "aaa")).toBe(true);
    expect(matchGlob("a*a*a", "aa")).toBe(false);
  });

  it("`x/**` also matches `x` itself (an origin with or without trailing slash)", () => {
    const glob = "http://www.allaboutcookies.org/**";
    expect(matchGlob(glob, "http://www.allaboutcookies.org")).toBe(true);
    expect(matchGlob(glob, "http://www.allaboutcookies.org/")).toBe(true);
    expect(matchGlob(glob, "http://www.allaboutcookies.org/a/b")).toBe(true);
    // Only the parent itself, not another host sharing the prefix
    expect(matchGlob(glob, "http://www.allaboutcookies.org.evil.com")).toBe(false);
    expect(matchGlob(glob, "http://www.allaboutcookies.orgx")).toBe(false);
    expect(matchGlob(glob, "https://www.allaboutcookies.org")).toBe(false);
    // Wildcards in the parent work as usual
    expect(matchGlob("https://*.x.com/**", "https://a.x.com")).toBe(true);
    expect(matchGlob("https://*.x.com/**", "https://a.b.x.com")).toBe(true);
    expect(matchGlob("docs/**", "docs")).toBe(true);
    expect(matchGlob("docs/**", "doc")).toBe(false);
    // Not for other wildcards at the end
    expect(matchGlob("https://x.com/*", "https://x.com")).toBe(false);
    expect(matchGlob("https://x.com**", "https://x.com")).toBe(true);
    // `/**` alone (empty parent) only matches the empty text under the globstar, not dropping the `/` too
    expect(matchGlob("/**", "")).toBe(false);
    expect(matchGlob("/**", "/")).toBe(true);
  });

  it("stays fast on inputs that make backtracking matchers explode", () => {
    const start = performance.now();
    const text = `${"a".repeat(5000)}b`;
    expect(matchGlob(`${"*a".repeat(200)}c`, text)).toBe(false);
    expect(matchGlob(`${"**a".repeat(200)}**c`, text)).toBe(false);
    expect(matchGlob(`${"*a".repeat(200)}*b`, text)).toBe(true);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
