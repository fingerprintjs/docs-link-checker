import { describe, expect, it } from "vitest";
import { serializeCorpus } from "./corpus_format";
import type { Corpus } from "./types";

const corpus: Corpus = {
  generatedAt: "2026-01-01T00:00:00.000Z",
  gitSha: "abcdef0123456",
  sources: ["checkLinks:docs"],
  sampleRate: 1,
  population: { linkCount: 2, uniqueUrlCount: 2, pageCount: 2, bySource: {}, byCheckedWith: {} },
  sample: { linkCount: 2, uniqueUrlCount: 2, pageCount: 2, bySource: {}, byCheckedWith: {} },
  links: [
    {
      page: "a",
      href: "https://example.com/a",
      text: "A",
      source: "docs",
      checkedWith: "fetch",
      outcome: "ok",
    },
    {
      page: "b",
      href: "https://example.com/b",
      text: "B",
      source: "web",
      checkedWith: "fetch",
      outcome: "ok",
    },
  ],
};

describe("serializeCorpus()", () => {
  it("round-trips through JSON.parse to the same corpus", () => {
    expect(JSON.parse(serializeCorpus(corpus))).toEqual(corpus);
  });

  it("writes one link per line", () => {
    const text = serializeCorpus(corpus);
    for (const link of corpus.links) {
      expect(text).toContain(`    ${JSON.stringify(link)}`);
    }
  });

  it("pretty-prints the metadata (not squashed onto one line)", () => {
    const text = serializeCorpus(corpus);
    expect(text).toContain('  "generatedAt": "2026-01-01T00:00:00.000Z"');
    expect(text).toContain('  "sampleRate": 1');
  });

  it("handles an empty links array", () => {
    const empty: Corpus = { ...corpus, links: [] };
    expect(JSON.parse(serializeCorpus(empty))).toEqual(empty);
  });
});
