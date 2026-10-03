import type { CheckedWith } from "../src/types";

/** One of the sources links are collected from, matching the package.json scripts of the same name */
export type CorpusSource = "docs" | "github" | "web";

/** One link of the frozen benchmark corpus, with the outcome it had when the corpus was generated */
export type CorpusLink = {
  page: string;
  href: string;
  text: string;
  source: CorpusSource;
  checkedWith: CheckedWith;
  /** "ok" or the error kind (`LinkCheckResult["error"]`), recorded so a benchmark round can flag drift */
  outcome: string;
};

/** Counts for a set of links, overall and broken down by source and check method, see `summarizeComposition` */
export type Composition = {
  linkCount: number;
  uniqueUrlCount: number;
  pageCount: number;
  bySource: Record<string, number>;
  byCheckedWith: Record<string, number>;
};

/** `bench/corpus.json`: a representative sample of real links, see `bench/collect_corpus.ts` */
export type Corpus = {
  generatedAt: string;
  gitSha: string;
  /** package.json scripts the links were collected from (`checkLinks:docs`, `checkLinks:github`, `checkLinks:web`) */
  sources: string[];
  /** Fraction of page groups kept per source, see `proportionalSample` in `bench/sample.ts` */
  sampleRate: number;
  /** Composition of every link checked while generating the corpus, before sampling */
  population: Composition;
  /** Composition of `links` (after sampling), to compare against `population` */
  sample: Composition;
  links: CorpusLink[];
};
