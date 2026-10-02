import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BaselineError,
  createBaseline,
  loadBaseline,
  updateBaseline,
  validateBaseline,
  writeBaseline,
} from "./baseline";
import { getJSONReport } from "./report/report";
import type { LinkWithResult } from "./types";

const broken = (href: string, page = "https://example.com/page"): LinkWithResult => ({
  href,
  page,
  text: "text",
  result: { ok: false, error: "broken link", status: 404 },
});

const tempDir = () => mkdtempSync(join(tmpdir(), "baseline-test-"));

describe("validateBaseline()", () => {
  it("accepts an object with `ignore`, a bare array and string shorthands", () => {
    expect(validateBaseline({ ignore: [{ href: "https://a.com" }] })).toEqual({
      ignore: [{ href: "https://a.com" }],
    });
    expect(validateBaseline(["https://a.com/**", { pattern: "https://b/*" }])).toEqual({
      ignore: [{ pattern: "https://a.com/**" }, { pattern: "https://b/*" }],
    });
    expect(validateBaseline({ $schema: "x", ignore: [] })).toEqual({ ignore: [] });
  });

  it.each([
    [null, /expected an object/],
    [42, /expected an object/],
    [{}, /expected an "ignore" array/],
    [{ ignore: "x" }, /"ignore" must be an array/],
    [{ ignore: [], extra: 1 }, /unknown top-level key\(s\): extra/],
    [[42], /ignore\[0\]: expected a string pattern or an object/],
    [[""], /ignore\[0\]: pattern must not be empty/],
    [[{ href: "a" }, { herf: "b" }], /ignore\[1\]: unknown key "herf"/],
    [[{ page: "a" }], /ignore\[0\]: expected exactly one of "href" or "pattern"/],
    [[{ href: "a", pattern: "b" }], /exactly one of/],
    [[{ href: 1 }], /ignore\[0\]: "href" must be a non-empty string/],
    [[{ href: "a", reason: "" }], /"reason" must be a non-empty string/],
    // Regular expressions are not supported (ReDoS), with a message pointing to globs
    [[{ regex: "(a+)+$" }], /ignore\[0\]: "regex" is not supported .* use a "pattern" glob/],
    [[{ regex: "^https://x" }], /"regex" is not supported/],
    [["x".repeat(2049)], /ignore\[0\]: pattern is longer than 2048 characters/],
    [[{ pattern: "x".repeat(2049) }], /"pattern" is longer than 2048 characters/],
    [[{ href: "a", page: "x".repeat(2049) }], /"page" is longer than 2048 characters/],
  ])("rejects %j", (data, message) => {
    expect(() => validateBaseline(data)).toThrow(BaselineError);
    expect(() => validateBaseline(data)).toThrow(message);
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
      { href: "https://ok.com/", page: "p", text: "t", result: { ok: true, status: 200 } },
      {
        href: "https://ok.com/hash#x",
        page: "p",
        text: "t",
        result: { ok: false, error: "could not check", status: 403 },
      },
    ],
    errors: [
      // A pool error (like `PromisePoolError`, only `item` and `message` are used)
      {
        item: { href: "https://error.com/x", page: "p", text: "t" },
        message: "boom",
      } as never,
    ],
  });

  it("moves matching failures to `ignored` with the reason, they don't count towards links to fix", () => {
    expect(report.summary).toEqual({
      linksChecked: 4,
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

  it("never ignores successful links", () => {
    expect(report.ignored.some((link) => link.result.ok)).toBe(false);
  });
});

describe("loadBaseline()", () => {
  it("loads a valid file", () => {
    const path = join(tempDir(), "baseline.json");
    writeFileSync(path, JSON.stringify({ ignore: [{ href: "https://a.com", reason: "r" }] }));
    expect(loadBaseline(path).findEntry(broken("https://a.com"))?.reason).toBe("r");
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
    expect(overlapping.findEntry(broken("https://broad.com/still-broken", "a.md"))?.reason).toBe(
      "broad",
    );
    expect(
      overlapping
        .findEntries(broken("https://broad.com/still-broken", "a.md"))
        .map((e) => e.reason),
    ).toEqual(["broad", "specific"]);
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
    expect(readFileSync(path, "utf8").endsWith("}\n")).toBe(true);
    const loaded = loadBaseline(path);
    for (const failure of failures) {
      expect(loaded.findEntry(failure)).toBeDefined();
    }
  });
});

describe("linkcheck.baseline.json (used by the default checks)", () => {
  const repoRoot = join(import.meta.dirname, "..");
  const baseline = loadBaseline(join(repoRoot, "linkcheck.baseline.json"));

  const couldNotCheck = (href: string, status = 403): LinkWithResult => ({
    href,
    page: "https://dev.fingerprint.com/docs/page",
    text: "text",
    result: { ok: false, error: "could not check", status },
  });

  // "Could not check" links of the reports: login walls (401) and bot-protected sites (403)
  const knownCouldNotCheck = [
    couldNotCheck("https://dashboard.fpjs.sh/integrations/active", 401),
    couldNotCheck("https://dashboard.fpjs.sh/suspect-score", 401),
    couldNotCheck("https://mcp.fpjs.io/mcp", 401),
    couldNotCheck("https://www.npmjs.com/package/@fingerprintjs/fingerprintjs-pro"),
    couldNotCheck("https://www.npmjs.com/package/@fingerprint/agent"),
    couldNotCheck("https://www.npmjs.com/package/create-cloudflare"),
    couldNotCheck("https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk"),
    couldNotCheck(
      "https://community.cloudflare.com/t/presence-of-query-string-make-route-match-fail/63400",
    ),
    couldNotCheck(
      "https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/templates/tree/main/worker-sites-react",
    ),
    couldNotCheck(
      "https://codesandbox.io/p/devbox/github/fingerprintjs/fingerprintjs-pro-use-cases/",
    ),
    couldNotCheck("https://my.bluehost.com/hosting/help/resource/714"),
    couldNotCheck("https://nordvpn.com/"),
    couldNotCheck("https://www.iso.org/iso-3166-country-codes.html"),
    // Reported as resolved by `new URL()` (with a trailing slash)
    couldNotCheck("http://www.allaboutcookies.org/"),
  ];

  it("moves the known 'could not check' links to the ignored section", () => {
    const report = getJSONReport({
      siteName: "test",
      baseline,
      links: knownCouldNotCheck,
      errors: [],
    });

    expect(report.summary.couldNotCheck).toBe(0);
    expect(report.summary.ignored).toBe(knownCouldNotCheck.length);
    expect(report.ignored.every((link) => link.ignoreReason)).toBe(true);
  });

  it("does not ignore real broken links", () => {
    const realBroken = [
      broken("https://support.microsoft.com/en-gb/help/278835/how-to-delete-cookie-files"),
      broken("https://fingerprint.com/blog/tag/workforce-identity/"),
      broken("https://api.fpjs.io/v4"),
      broken("https://github.com/fingerprintjs/fingerprintjs-pro-spa/blob/master/LICENSE"),
      broken("https://docs.flutter.dev/get-started/install/macos/mobile-ios"),
    ];
    const report = getJSONReport({ siteName: "test", baseline, links: realBroken, errors: [] });

    expect(report.summary.ignored).toBe(0);
    expect(report.summary.brokenLinks).toBe(realBroken.length);
  });

  it("is passed to the default checks", () => {
    const { scripts } = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    for (const script of ["checkLinks:docs", "checkLinks:github", "checkLinks:web"]) {
      expect(scripts[script]).toContain("--baseline linkcheck.baseline.json");
    }
  });
});
