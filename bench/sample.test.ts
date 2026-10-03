import { describe, expect, it } from "vitest";
import { groupByPage, proportionalSample } from "./sample";

describe("groupByPage()", () => {
  it("groups hrefs that point to the same page (URL without hash), keeping first-appearance order", () => {
    const items = [
      { href: "https://example.com/a" },
      { href: "https://example.com/b#one" },
      { href: "https://example.com/a#two" },
      { href: "https://example.com/b#three" },
    ];
    expect(groupByPage(items)).toEqual([
      [items[0], items[2]],
      [items[1], items[3]],
    ]);
  });
});

type Item = { href: string; source: string };

const page = (href: string, source: string): Item => ({ href, source });

describe("proportionalSample()", () => {
  it("keeps the same fraction of page groups in every source, not just of the combined pool", () => {
    // A source with few groups must not be crowded out by one with many
    const items = [
      ...Array.from({ length: 100 }, (_, i) => page(`https://docs.example.com/page-${i}`, "docs")),
      ...Array.from({ length: 10 }, (_, i) =>
        page(`https://github.example.com/page-${i}`, "github"),
      ),
    ];
    const sample = proportionalSample(items, (item) => item.source, 0.1);
    const bySource = (source: string) => sample.filter((item) => item.source === source);
    expect(bySource("docs")).toHaveLength(10);
    expect(bySource("github")).toHaveLength(1);
  });

  it("keeps a page group intact: every hash of a sampled page is kept, never split", () => {
    const items = [
      page("https://example.com/a#one", "docs"),
      page("https://example.com/a#two", "docs"),
      page("https://example.com/b", "docs"),
      page("https://example.com/c", "docs"),
    ];
    const sample = proportionalSample(items, (item) => item.source, 0.5);
    const sampledHrefs = sample.map((item) => item.href);
    const sampledPages = new Set(sampledHrefs.map((href) => href.split("#")[0] ?? href));
    for (const pageUrl of sampledPages) {
      const hrefs = items.filter((item) => item.href.startsWith(pageUrl)).map((item) => item.href);
      for (const href of hrefs) {
        expect(sampledHrefs).toContain(href);
      }
    }
  });

  it("is deterministic: running it again on the same input picks the same groups", () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      page(`https://example.com/page-${i}`, "web"),
    );
    expect(proportionalSample(items, (item) => item.source, 0.3)).toEqual(
      proportionalSample(items, (item) => item.source, 0.3),
    );
  });

  it("keeps at least one group per source, even at a very low rate", () => {
    const items = [page("https://example.com/only-one", "docs")];
    expect(proportionalSample(items, (item) => item.source, 0.001)).toEqual(items);
  });

  it("returns every group unchanged at a rate of 1", () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      page(`https://example.com/page-${i}`, "docs"),
    );
    expect(proportionalSample(items, (item) => item.source, 1)).toEqual(items);
  });
});
