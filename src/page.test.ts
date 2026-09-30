import { describe, it, expect } from "vitest";
import { filterOutIrrelevantLinks } from "./page";

const link = (href: string) => ({ href, text: "text", page: "https://example.com/page" });

describe("filterOutIrrelevantLinks()", () => {
  it("keeps http(s) links and unparsable URLs (reported as broken later)", () => {
    const links = [link("https://example.com/a"), link("http://example.com/b"), link("not a url")];
    expect(filterOutIrrelevantLinks(links)).toEqual(links);
  });

  it("skips links with non-http(s) schemes", () => {
    const links = ["tel:+123", "javascript:void(0)", "data:text/plain,hi", "mailto:a@b.com", "ftp://example.com/f"];
    expect(filterOutIrrelevantLinks(links.map(link))).toEqual([]);
  });
});
