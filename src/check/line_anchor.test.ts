import { describe, expect, it } from "vitest";
import { checkLineAnchor, countLines, isGithubCodeLineLink, parseLineAnchor } from "./line_anchor";

describe("countLines()", () => {
  it.each([
    ["", 0],
    ["a", 1],
    ["a\n", 1],
    ["a\nb", 2],
    ["a\nb\n", 2],
    ["a\nb\n\n", 3],
    ["\n", 1],
    ["a\r\nb\r\n", 2],
  ])("%j has %i lines", (text, lines) => {
    expect(countLines(text)).toBe(lines);
  });
});

describe("parseLineAnchor()", () => {
  it("parses lines, ranges and columns", () => {
    expect(parseLineAnchor("L12")).toEqual({ firstLine: 12, lastLine: 12 });
    expect(parseLineAnchor("L12-L15")).toEqual({ firstLine: 12, lastLine: 15 });
    expect(parseLineAnchor("L2C5-L3C1")).toEqual({ firstLine: 2, lastLine: 3 });
  });

  it.each(["l12", "L", "L12-", "L12-15", "installation", "L1x"])(
    "%s is not a line anchor",
    (hash) => {
      expect(parseLineAnchor(hash)).toBeUndefined();
    },
  );
});

describe("checkLineAnchor()", () => {
  it("accepts lines within the file", () => {
    expect(checkLineAnchor("L1", 3, "a.ts")).toEqual({ ok: true, status: 200 });
    expect(checkLineAnchor("L3", 3, "a.ts")).toEqual({ ok: true, status: 200 });
    expect(checkLineAnchor("L1-L3", 3, "a.ts")).toEqual({ ok: true, status: 200 });
    expect(checkLineAnchor("L2-L2", 3, "a.ts")).toEqual({ ok: true, status: 200 });
  });

  it("reports lines past the end of the file", () => {
    expect(checkLineAnchor("L4", 3, "a.ts")).toEqual({
      ok: false,
      error: "hash not found",
      status: 200,
      errorDetail: "a.ts has only 3 lines",
    });
    expect(checkLineAnchor("L1-L4", 3, "a.ts")).toMatchObject({ ok: false });
    expect(checkLineAnchor("L1", 0, "empty.ts")).toMatchObject({
      ok: false,
      errorDetail: "empty.ts has only 0 lines",
    });
    expect(checkLineAnchor("L2", 1, "a.ts")).toMatchObject({ errorDetail: "a.ts has only 1 line" });
  });

  it.each(["L0", "L0-L2", "L2-L0", "L3-L2"])("reports %s as invalid", (hash) => {
    expect(checkLineAnchor(hash, 100, "a.ts")).toEqual({
      ok: false,
      error: "hash not found",
      status: 200,
      errorDetail: `Invalid line anchor #${hash} (lines start at 1, ranges go forward)`,
    });
  });

  it("returns undefined for other hashes", () => {
    expect(checkLineAnchor("installation", 3, "a.ts")).toBeUndefined();
  });
});

describe("isGithubCodeLineLink()", () => {
  const file = "https://github.com/owner/repo/blob/main/file.js";

  it.each([
    "#L5",
    "#L5-L10",
    // Same grammar as `parseLineAnchor`: columns
    "#L2C5",
    "#L2C5-L3C1",
    "#L2-L3C1",
    "#L2C5-L3",
    // Percent-encoded
    "#%4C12",
    "#L12%2DL20",
    "#L2C5%2DL3C1",
  ])("accepts %s", (hash) => {
    expect(isGithubCodeLineLink(`${file}${hash}`)).toBe(true);
  });

  it.each([
    "#L",
    "#L5-",
    "#L-L10",
    "#L5-L10-L15",
    "#L5C",
    // Case-sensitive
    "#l5",
    // Malformed percent-encoding does not throw
    "#L12%",
  ])("rejects %s", (hash) => {
    expect(isGithubCodeLineLink(`${file}${hash}`)).toBe(false);
  });

  it("rejects line hashes of links that are not blobs", () => {
    expect(isGithubCodeLineLink("https://github.com/owner/repo/tree/main/dir#L5")).toBe(false);
  });
});
