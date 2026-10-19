import { describe, expect, it } from "vitest";
import { extractSourceCodeLinks } from "./source_code";

describe("extractSourceCodeLinks()", () => {
  it("finds absolute URLs in JSX, strings and comments, with their line", () => {
    const code = [
      "<DocsLink href='https://docs.example.com/a#proximity'>A</DocsLink>", // 1
      '<a href="https://example.com/b?x=1&y=2">B</a>', // 2
      "const url = `https://example.com/c`;", // 3
      "// See https://example.com/d. And (https://example.com/e), https://example.com/f;", // 4
      "<Link href={'http://example.com/g'} />", // 5
      "fetch(new URL('https://example.com/h'))", // 6
    ].join("\n");
    expect(extractSourceCodeLinks(code)).toEqual([
      { href: "https://docs.example.com/a#proximity", text: "", line: 1 },
      { href: "https://example.com/b?x=1&y=2", text: "", line: 2 },
      { href: "https://example.com/c", text: "", line: 3 },
      { href: "https://example.com/d", text: "", line: 4 },
      { href: "https://example.com/e", text: "", line: 4 },
      { href: "https://example.com/f", text: "", line: 4 },
      { href: "http://example.com/g", text: "", line: 5 },
      { href: "https://example.com/h", text: "", line: 6 },
    ]);
  });

  it("skips URL templates, bare schemes and relative links", () => {
    const code = [
      "const a = `https://example.com/${id}/x`;",
      "const b = `https://${host}/x`;",
      "const c = 'https://api.example.com/visitors/{visitorId}';",
      "if (url.startsWith('https://')) {}",
      "<Link href='/playground'>Playground</Link>",
    ].join("\n");
    expect(extractSourceCodeLinks(code)).toEqual([]);
  });
});
