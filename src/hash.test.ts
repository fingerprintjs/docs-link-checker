import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import { cssString, decodeHash, getHashSelectors, isHashPresentInHtml } from "./hash";

const html = readFileSync(join(import.meta.dirname, "__fixtures__", "hashes.html"), "utf8");
const PAGE = "https://example.com/docs";

// Hashes as they appear in URLs (`new URL(...).hash`), pointing to elements in the fixture
const existingHashes = [
  "#simple",
  "#version-1.2.3",
  "#1-create-an-account",
  "#namespace:item",
  "#path/to/section",
  "#it's-quoted",
  '#say-"hi"',
  "#say-%22hi%22",
  "#back\\slash",
  "#caf%C3%A9",
  "#legacy-anchor",
  "#installation",
  "#InStAlLaTiOn",
];

const missingHashes = ["#does-not-exist", "#not-an-anchor", "#version-1-2-3", "#%E0%A4%A", "#]", '#"]'];

describe("decodeHash", () => {
  it("removes the # and decodes percent-encoding", () => {
    expect(decodeHash("#caf%C3%A9")).toBe("café");
    expect(decodeHash("caf%C3%A9")).toBe("café");
    expect(decodeHash("#say-%22hi%22")).toBe('say-"hi"');
  });

  it("returns invalid percent-encoding as-is", () => {
    expect(decodeHash("#100%-sure")).toBe("100%-sure");
  });
});

describe("cssString", () => {
  it("escapes quotes, backslashes and newlines", () => {
    expect(cssString('a"b\\c\nd')).toBe('"a\\"b\\\\c\\a d"');
  });

  it("escapes every non-printable character, so any hash gives a valid selector", () => {
    expect(cssString("a\u0001b\u001fc\u007fd")).toBe('"a\\1 b\\1f c\\7f d"');
    // A control character in a hash (`#%01section`) must not break the selector
    expect(isHashPresentInHtml('<h2 id="\u0001section">A</h2>', "#%01section", PAGE)).toBe(true);
  });
});

describe("isHashPresentInHtml()", () => {
  it.each(existingHashes)("finds %s", (hash) => {
    expect(isHashPresentInHtml(html, hash, PAGE)).toBe(true);
  });

  it.each(missingHashes)("does not find (or throw for) %s", (hash) => {
    expect(isHashPresentInHtml(html, hash, PAGE)).toBe(false);
  });

  it("finds GitHub line numbers only for GitHub code line links", () => {
    expect(isHashPresentInHtml(html, "#L12", "https://github.com/o/r/blob/main/a.js#L12")).toBe(true);
    expect(isHashPresentInHtml(html, "#L12-L20", "https://github.com/o/r/blob/main/a.js#L12-L20")).toBe(
      true
    );
    expect(isHashPresentInHtml(html, "#L13", "https://github.com/o/r/blob/main/a.js#L13")).toBe(false);
    expect(isHashPresentInHtml(html, "#L12", `${PAGE}#L12`)).toBe(false);
  });
});

describe("getHashSelectors() (used by Playwright)", () => {
  const $ = cheerio.load(html);
  const matches = (hash: string, url = PAGE) => $(getHashSelectors(hash, url).join(", ")).length > 0;

  it.each(existingHashes)("builds a valid selector that matches %s", (hash) => {
    // Playwright gets the hash without the leading `#`
    expect(matches(hash.slice(1))).toBe(true);
  });

  it.each(missingHashes)("builds a valid selector that does not match %s", (hash) => {
    expect(() => $(getHashSelectors(hash.slice(1), PAGE).join(", "))).not.toThrow();
    expect(matches(hash.slice(1))).toBe(false);
  });

  it("matches GitHub line numbers for GitHub code line links", () => {
    expect(matches("L12-L20", "https://github.com/o/r/blob/main/a.js#L12-L20")).toBe(true);
    expect(matches("L13", "https://github.com/o/r/blob/main/a.js#L13")).toBe(false);
  });
});
