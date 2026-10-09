import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BaselineError,
  createBaseline,
  loadBaseline,
  updateBaseline,
  writeBaseline,
} from "./baseline";
import { getJSONReport } from "./report/report";
import type { LinkWithResult } from "./types";

const RUN = { generatedAt: new Date("2026-01-02T03:04:05Z"), durationMs: 1234 };

const broken = (href: string, page = "https://example.com/page"): LinkWithResult => ({
  href,
  page,
  text: "text",
  result: { ok: false, error: "broken link", status: 404 },
});

const tempDir = () => mkdtempSync(join(tmpdir(), "baseline-test-"));

// Validation is tested through `loadBaseline`, the public entry point
const load = (data: unknown) => {
  const path = join(tempDir(), "baseline.json");
  writeFileSync(path, JSON.stringify(data));
  return loadBaseline(path);
};

describe("loadBaseline() validation", () => {
  it("accepts an object with `ignore`, a bare array and string shorthands", () => {
    expect(load({ ignore: [{ href: "https://a.com" }] }).entries).toEqual([
      { href: "https://a.com" },
    ]);
    expect(load(["https://a.com/**", { pattern: "https://b/*" }]).entries).toEqual([
      { pattern: "https://a.com/**" },
      { pattern: "https://b/*" },
    ]);
    expect(load({ $schema: "x", ignore: [] }).entries).toEqual([]);
    expect(load({ $schema: null, ignore: [] }).entries).toEqual([]);
  });

  it.each([
    [null, /expected object, received null/],
    [42, /expected object, received number/],
    [{}, /ignore: .*expected array/],
    [{ ignore: "x" }, /ignore: .*expected array/],
    [{ ignore: [], extra: 1 }, /Unrecognized key: "extra"/],
    [[42], /ignore\[0\]: .*expected object, received number/],
    [[""], /ignore\[0\].pattern: .*>=1 characters/],
    [[{ href: "a" }, { herf: "b" }], /ignore\[1\]: Unrecognized key: "herf"/],
    [[{ page: "a" }], /ignore\[0\]: expected exactly one of "href" or "pattern"/],
    [[{ href: "a", pattern: "b" }], /exactly one of/],
    [[{ href: 1 }], /ignore\[0\].href: .*expected string/],
    [[{ href: "a", reason: "" }], /ignore\[0\].reason: .*>=1 characters/],
    // Regular expressions are not supported (ReDoS), with a message pointing to globs
    [[{ regex: "(a+)+$" }], /ignore\[0\]: "regex" is not supported .* use a "pattern" glob/],
    [[{ regex: "^https://x" }], /"regex" is not supported/],
    [["x".repeat(2049)], /ignore\[0\].pattern: .*<=2048 characters/],
    [[{ pattern: "x".repeat(2049) }], /ignore\[0\].pattern: .*<=2048 characters/],
    [[{ href: "a", page: "x".repeat(2049) }], /ignore\[0\].page: .*<=2048 characters/],
  ])("rejects %j", (data, message) => {
    expect(() => load(data)).toThrow(BaselineError);
    expect(() => load(data)).toThrow(message);
  });
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
    ...RUN,
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

describe("loadBaseline()", () => {
  it("loads a valid file", () => {
    const path = join(tempDir(), "baseline.json");
    writeFileSync(path, JSON.stringify({ ignore: [{ href: "https://a.com", reason: "r" }] }));
    expect(loadBaseline(path).findEntry(broken("https://a.com"))?.reason).toBe("r");
  });

  it("loads the repository baseline file", () => {
    const { entries } = loadBaseline(join(import.meta.dirname, "..", "linkcheck.baseline.json"));
    expect(entries.length).toBeGreaterThan(0);
  });

  it("reports missing files, unless allowed", () => {
    const path = join(tempDir(), "missing.json");
    expect(() => loadBaseline(path)).toThrow(`Baseline file not found: ${path}`);
    expect(loadBaseline(path, { allowMissing: true }).entries).toEqual([]);
  });

  it("reports invalid JSON and invalid entries with the file name", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "bad.json"), "{ not json");
    expect(() => loadBaseline(join(dir, "bad.json"))).toThrow(/Invalid baseline file .*bad\.json/);
    writeFileSync(join(dir, "invalid.json"), JSON.stringify({ ignore: [{ reason: "x" }] }));
    expect(() => loadBaseline(join(dir, "invalid.json"))).toThrow(
      /Invalid baseline file .*invalid\.json: ignore\[0\]: expected exactly one of/,
    );
  });
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

  it("writes a file that loads back", () => {
    const path = join(tempDir(), "baseline.json");
    writeBaseline(path, updateBaseline({ baseline, failures }));
    const loaded = loadBaseline(path);
    for (const failure of failures) {
      expect(loaded.findEntry(failure)).toBeDefined();
    }
  });
});
