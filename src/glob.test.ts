import { describe, expect, it } from "vitest";
import { matchGlob, parseGlob } from "./glob";

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

describe("matchGlob()", () => {
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

  it("stays fast on inputs that make backtracking matchers explode", () => {
    const start = performance.now();
    const text = `${"a".repeat(5000)}b`;
    expect(matchGlob(`${"*a".repeat(200)}c`, text)).toBe(false);
    expect(matchGlob(`${"**a".repeat(200)}**c`, text)).toBe(false);
    expect(matchGlob(`${"*a".repeat(200)}*b`, text)).toBe(true);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
