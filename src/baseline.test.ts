import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import {
  createBaseline,
  loadBaseline,
  updateBaseline,
  writeBaseline,
  type BaselineFile,
} from "./baseline";
import { BaselineError } from "./errors";
import { getJSONReport } from "./report/report";
import type { LinkWithResult } from "./types";

const broken = (href: string, page = "https://example.com/page"): LinkWithResult => ({
  href,
  page,
  text: "text",
  result: { ok: false, error: "broken link", status: 404 },
});

/** Writes `content` to a temp file, loads it as a baseline */
const load = (content: unknown, options?: { allowMissing?: boolean }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const path = join(dir, "baseline.json");
    yield* fs.writeFileString(
      path,
      typeof content === "string" ? content : JSON.stringify(content),
    );
    return yield* loadBaseline(path, options);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer));

describe("loadBaseline() validation", () => {
  it.effect("accepts an object with `ignore`, a bare array and string shorthands", () =>
    Effect.gen(function* () {
      expect((yield* load({ ignore: [{ href: "https://a.com" }] })).entries).toEqual([
        { href: "https://a.com" },
      ]);
      expect((yield* load(["https://a.com/**", { pattern: "https://b/*" }])).entries).toEqual([
        { pattern: "https://a.com/**" },
        { pattern: "https://b/*" },
      ]);
      expect((yield* load({ $schema: "x", ignore: [] })).entries).toEqual([]);
      expect((yield* load({ $schema: null, ignore: [] })).entries).toEqual([]);
    }),
  );

  // Paths and the custom messages are ours, generic type mismatches are worded by Effect Schema
  const invalidFiles: Array<[unknown, RegExp]> = [
    [null, /baseline: Expected object, actual null/],
    [42, /baseline: Expected object, actual 42/],
    [{}, /ignore: is missing/],
    [{ ignore: "x" }, /ignore: Expected array, actual "x"/],
    [{ ignore: [], extra: 1 }, /extra: is unexpected/],
    [[42], /ignore\[0\]: Expected object, actual 42/],
    [[""], /ignore\[0\].pattern: expected a non-empty string/],
    [[{ href: "a" }, { herf: "b" }], /ignore\[1\].herf: is unexpected/],
    [[{ page: "a" }], /ignore\[0\]: expected exactly one of "href" or "pattern"/],
    [[{ href: "a", pattern: "b" }], /exactly one of/],
    [[{ href: 1 }], /ignore\[0\].href: Expected string, actual 1/],
    [[{ href: "a", reason: "" }], /ignore\[0\].reason: expected a non-empty string/],
    // Regular expressions are not supported (ReDoS), with a message pointing to globs
    [[{ regex: "(a+)+$" }], /ignore\[0\].regex: "regex" is not supported .* use a "pattern" glob/],
    [[{ regex: "^https://x" }], /"regex" is not supported/],
    [["x".repeat(2049)], /ignore\[0\].pattern: expected at most 2048 characters/],
    [[{ pattern: "x".repeat(2049) }], /ignore\[0\].pattern: expected at most 2048 characters/],
    [[{ href: "a", page: "x".repeat(2049) }], /ignore\[0\].page: expected at most 2048 characters/],
  ];
  it.each(invalidFiles)("rejects %j", async (data, message) => {
    const error = await Effect.runPromise(Effect.flip(load(data)));
    expect(error).toBeInstanceOf(BaselineError);
    expect(error.message).toMatch(message);
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
  it.effect("loads a valid file", () =>
    load({ ignore: [{ href: "https://a.com", reason: "r" }] }).pipe(
      Effect.tap((baseline) =>
        expect(baseline.findEntry(broken("https://a.com"))?.reason).toBe("r"),
      ),
    ),
  );

  it.effect("loads the repository baseline file", () =>
    loadBaseline(join(import.meta.dirname, "..", "linkcheck.baseline.json")).pipe(
      Effect.provide(NodeFileSystem.layer),
      Effect.tap(({ entries }) => expect(entries.length).toBeGreaterThan(0)),
    ),
  );

  it.effect("reports missing files, unless allowed", () =>
    Effect.gen(function* () {
      const path = join(import.meta.dirname, "does-not-exist.json");
      const error = yield* loadBaseline(path).pipe(Effect.flip);
      expect(error.message).toBe(`Baseline file not found: ${path}`);
      const baseline = yield* loadBaseline(path, { allowMissing: true });
      expect(baseline.entries).toEqual([]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("reports a file that cannot be read", () =>
    loadBaseline(import.meta.dirname).pipe(
      Effect.provide(NodeFileSystem.layer),
      Effect.flip,
      Effect.tap((error) =>
        expect(error.message).toContain(`Invalid baseline file ${import.meta.dirname}`),
      ),
    ),
  );

  it.effect("reports invalid JSON and invalid entries with the file name", () =>
    Effect.gen(function* () {
      const notJson = yield* load("{ not json").pipe(Effect.flip);
      // The JSON parser message as is, no path label
      expect(notJson.message).toMatch(/^Invalid baseline file .*baseline\.json: (?!baseline:).+/);
      const invalid = yield* load({ ignore: [{ reason: "x" }] }).pipe(Effect.flip);
      expect(invalid.message).toMatch(
        /^Invalid baseline file .*baseline\.json: ignore\[0\]: expected exactly one of/,
      );
    }),
  );
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

  it.effect("writes a file that loads back", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const path = join(dir, "baseline.json");
      const file: BaselineFile = updateBaseline({ baseline, failures });
      yield* writeBaseline(path, file);
      expect(yield* fs.readFileString(path)).toBe(`${JSON.stringify(file, null, 2)}\n`);
      const loaded = yield* loadBaseline(path);
      for (const failure of failures) {
        expect(loaded.findEntry(failure)).toBeDefined();
      }
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );
});
