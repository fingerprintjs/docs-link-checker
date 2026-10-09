import { describe, expect, it } from "vitest";
import type { LinkCheckResult, LinkWithResult } from "../types";
import { displayUrl, groupByTarget, problemLabel, shortReason } from "./format";

const failed = (
  href: string,
  result: Extract<LinkCheckResult, { ok: false }>,
  page = "https://example.com/page",
): LinkWithResult => ({ href, page, text: "t", result });

describe("problemLabel()", () => {
  it.each([
    ["https://x.com/a#nope", { error: "hash not found", status: 200 }, "Anchor not found"],
    ["https://github.com/o/r/blob/main/a.ts#L99", { error: "hash not found" }, "Line out of range"],
    ["https://x.com/a", { error: "broken link", status: 404 }, "HTTP 404"],
    ["https://x.com/a", { error: "broken link" }, "Network error"],
    ["https://x.com/a", { error: "unexpected error" }, "Network error"],
    ["https://x.com/a", { error: "could not check", status: 403 }, "Could not check (403)"],
    ["https://x.com/a", { error: "could not check" }, "Could not check"],
  ] as const)("%s %j -> %s", (href, error, label) => {
    expect(problemLabel(failed(href, { ok: false, ...error }))).toBe(label);
  });

  it("calls a broken local link without status a missing file", () => {
    expect(problemLabel(failed("a.md", { ok: false, error: "broken link" }, "docs/b.md"))).toBe(
      "File not found",
    );
  });
});

describe("shortReason()", () => {
  const reason = (errorDetail: string | undefined, error: "broken link" | "hash not found") =>
    shortReason(failed("https://x.com/a#b", { ok: false, error, errorDetail }));

  it("cuts HTML response bodies", () => {
    expect(reason("Not Found <!doctype html><html>\n<body>nope</body>", "broken link")).toBe(
      "Not Found",
    );
  });

  it("is a single short line", () => {
    const text = reason(`one\n  two\n${"x".repeat(300)}`, "broken link");
    expect(text).not.toContain("\n");
    expect(text.startsWith("one two xxx")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(100);
  });

  it.each([
    ["No heading matching #nope in docs/a.md", "no heading #nope in docs/a.md"],
    ["No heading found matching hash: nope", "no heading #nope"],
    ["File not found: docs/missing.md", "no file docs/missing.md"],
    ["src/code.ts has only 3 lines", "src/code.ts has 3 lines"],
  ])("simplifies %j", (detail, expected) => {
    expect(reason(detail, "hash not found")).toBe(expected);
  });

  it("says something for a missing anchor without detail", () => {
    expect(reason(undefined, "hash not found")).not.toBe("");
  });
});

describe("groupByTarget()", () => {
  const link = (href: string, page: string, status = 404, ignoreReason?: string) => ({
    ...failed(href, { ok: false, error: "broken link", status }, page),
    ...(ignoreReason ? { ignoreReason } : {}),
  });

  it("groups pages linking to the same target and problem, most pages first", () => {
    const groups = groupByTarget([
      link("https://x.com/one", "https://s.com/a"),
      link("https://x.com/two", "https://s.com/a"),
      link("https://x.com/two", "https://s.com/b"),
      link("https://x.com/two", "https://s.com/c"),
    ]);
    expect(groups.map((g) => [g.link.href, g.pages.length])).toEqual([
      ["https://x.com/two", 3],
      ["https://x.com/one", 1],
    ]);
  });

  it("keeps different problems and ignore reasons of a target apart", () => {
    const groups = groupByTarget([
      link("https://x.com/a", "https://s.com/a", 404),
      link("https://x.com/a", "https://s.com/b", 500),
      link("https://x.com/a", "https://s.com/c", 404, "flaky"),
    ]);
    expect(groups).toHaveLength(3);
  });

  it("resolves relative links against their page", () => {
    const groups = groupByTarget([
      link("missing.md", "a/README.md"),
      link("missing.md", "b/README.md"),
      link("../a/missing.md", "b/README.md"),
    ]);
    expect(groups.map((g) => g.pages.map((p) => p.page))).toEqual([
      ["a/README.md", "b/README.md"],
      ["b/README.md"],
    ]);
  });
});

describe("displayUrl()", () => {
  it("drops the origin of the checked site", () => {
    expect(displayUrl("https://docs.x.com/ref/a?q=1#h", "https://docs.x.com")).toBe("/ref/a?q=1#h");
  });

  it("drops https:// of other URLs, keeps http://", () => {
    expect(displayUrl("https://dev.x.com/a#h", "https://docs.x.com")).toBe("dev.x.com/a#h");
    expect(displayUrl("http://dev.x.com/a")).toBe("http://dev.x.com/a");
  });

  it("returns local paths unchanged", () => {
    expect(displayUrl("docs/a.md", "https://docs.x.com")).toBe("docs/a.md");
  });
});
