import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import {
  buildAnchorIndex,
  decodeHash,
  getHashSelectors,
  getSpecialFragmentNote,
  isHashInAnchorIndex,
} from "./hash";

const html = readFileSync(join(import.meta.dirname, "..", "__fixtures__", "hashes.html"), "utf8");
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

const missingHashes = [
  "#does-not-exist",
  "#not-an-anchor",
  "#version-1-2-3",
  "#%E0%A4%A",
  "#]",
  '#"]',
];

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

describe("buildAnchorIndex() / isHashInAnchorIndex()", () => {
  const index = buildAnchorIndex(html);

  it.each(existingHashes)("finds %s", (hash) => {
    expect(isHashInAnchorIndex(index, hash)).toBe(true);
  });

  it.each(missingHashes)("does not find (or throw for) %s", (hash) => {
    expect(isHashInAnchorIndex(index, hash)).toBe(false);
  });
});

describe("getHashSelectors() (used by Playwright)", () => {
  const $ = cheerio.load(html);
  const matches = (hash: string, url = PAGE) =>
    $(getHashSelectors(hash, url).join(", ")).length > 0;

  it.each(existingHashes)("builds a valid selector that matches %s", (hash) => {
    // Playwright gets the hash without the leading `#`
    expect(matches(hash.slice(1))).toBe(true);
  });

  it.each(missingHashes)("builds a valid selector that does not match %s", (hash) => {
    expect(matches(hash.slice(1))).toBe(false);
  });

  it("builds a valid selector for a hash with a control character", () => {
    const withControlChar = cheerio.load('<h2 id="\u0001section">A</h2>');
    expect(withControlChar(getHashSelectors("%01section", PAGE).join(", ")).length).toBe(1);
  });

  it("matches GitHub line numbers for GitHub code line links", () => {
    expect(matches("L12-L20", "https://github.com/o/r/blob/main/a.js#L12-L20")).toBe(true);
    expect(matches("L13", "https://github.com/o/r/blob/main/a.js#L13")).toBe(false);
    expect(matches("L12C3", "https://github.com/o/r/blob/main/a.js#L12C3")).toBe(true);
  });
});

describe("getSpecialFragmentNote()", () => {
  it("accepts zippy fragments on Google Help only", () => {
    expect(getSpecialFragmentNote("zippy=,a", "https://support.google.com/x#zippy=,a")).toBe(
      "Google Help accordion state",
    );
    expect(getSpecialFragmentNote("zippy=,a", "https://SUPPORT.Google.com/x")).toBe(
      "Google Help accordion state",
    );
    expect(getSpecialFragmentNote("zippy=,a", "https://example.com/x")).toBeUndefined();
    expect(
      getSpecialFragmentNote("zippy=,a", "https://support.google.com.evil.com/x"),
    ).toBeUndefined();
    expect(getSpecialFragmentNote("zippy=,a", "https://google.com/x")).toBeUndefined();
    expect(getSpecialFragmentNote("not-zippy=1", "https://support.google.com/x")).toBeUndefined();
    // Not host-specific
    expect(getSpecialFragmentNote("/", "https://example.com/x")).toBe("Accidental hash");
    expect(getSpecialFragmentNote(":~:text=a", "https://example.com/x")).toBe("Text Fragment");
  });
});
