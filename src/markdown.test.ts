import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractMarkdownLinks, getMarkdownAnchors, hasMatchingAnchor } from "./markdown";

describe("extractMarkdownLinks()", () => {
  it("returns links with line numbers, ignoring code blocks", () => {
    const markdown = [
      "# Title", // 1
      "", // 2
      "[a](a.md) and [b](b.md)", // 3
      "```", // 4
      "[code](code.md)", // 5
      "```", // 6
      "| col | col |", // 7
      "| --- | --- |", // 8
      "| [t](t.md) | x |", // 9
      "> quote [q](q.md)", // 10
      "[a](a.md)", // 11
      "<https://auto.link>", // 12
    ].join("\n");
    expect(extractMarkdownLinks(markdown)).toEqual([
      { href: "a.md", text: "a", line: 3 },
      { href: "b.md", text: "b", line: 3 },
      { href: "t.md", text: "t", line: 9 },
      { href: "q.md", text: "q", line: 10 },
      // Same link again: found after the first one
      { href: "a.md", text: "a", line: 11 },
      { href: "https://auto.link", text: "https://auto.link", line: 12 },
    ]);
  });

  it("handles CRLF line endings and formatted link text", () => {
    expect(extractMarkdownLinks("line\r\n\r\n[**bold** `code`](x.md)\r\n")).toEqual([
      { href: "x.md", text: "bold code", line: 3 },
    ]);
  });

  it("resolves reference links", () => {
    expect(extractMarkdownLinks("text\n\n[ref link][ref]\n\n[ref]: docs/a.md#x\n")).toEqual([
      { href: "docs/a.md#x", text: "ref link", line: 3 },
    ]);
  });
});

describe("getMarkdownAnchors() and hasMatchingAnchor()", () => {
  const readme = readFileSync(join(import.meta.dirname, "__fixtures__", "readme.md"), "utf8");
  const anchors = getMarkdownAnchors(readme);

  it("includes heading slugs", () => {
    expect(anchors).toContain("getting-started");
    expect(anchors).toContain("installation");
    expect(anchors).toContain("setext-heading");
    expect(anchors).toContain("a--b");
  });

  it("slugs the rendered heading text (no markdown syntax or link URLs)", () => {
    expect(anchors).toContain("usage-with-code-and-bold-and-a-link");
  });

  it("drops inline HTML tags and image alt text from heading slugs", () => {
    expect(getMarkdownAnchors("# Press <kbd>Ctrl</kbd> ![logo](a.png) now")).toContain(
      "press-ctrl--now",
    );
  });

  it("adds -1, -2 suffixes to duplicate headings", () => {
    expect(anchors).toContain("usage");
    expect(anchors).toContain("usage-1");
    expect(anchors).not.toContain("usage-2");
  });

  it("includes headings in blockquotes and lists", () => {
    expect(anchors).toContain("heading-in-a-quote");
    expect(anchors).toContain("heading-in-a-list");
  });

  it("ignores # lines inside fenced code blocks", () => {
    expect(anchors).not.toContain("not-a-heading");
    expect(anchors).not.toContain("also-not-a-heading");
  });

  it("includes explicit HTML anchors", () => {
    expect(anchors).toContain("custom-anchor"); // <a name="...">
    expect(anchors).toContain("inline-anchor"); // <a id="...">
    expect(anchors).toContain("project-logo"); // <h1 id="...">
  });

  it("matches a hash with or without GitHub's user-content- prefix", () => {
    expect(hasMatchingAnchor(anchors, "installation")).toBe(true);
    expect(hasMatchingAnchor(anchors, "user-content-installation")).toBe(true);
    expect(hasMatchingAnchor(anchors, "nope")).toBe(false);
  });
});
