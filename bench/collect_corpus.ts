/**
 * Regenerates `bench/corpus.json`: a frozen, representative sample of real links, collected from the same sources
 * and settings as our production workflow (`package.json` scripts `checkLinks:docs`, `checkLinks:github`,
 * `checkLinks:web`), checked once so each link's `checkedWith` and outcome are known.
 *
 * Run it again when:
 * - the checked sources or `--include` prefixes change (keep this file in sync with `checkLinks:*` in package.json)
 * - the corpus has drifted far enough from the live sites that its outcomes are mostly stale
 *
 * Needs a `GH_TOKEN` environment variable and network access, same as `pnpm run checkLinks:*`.
 */
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getReadmeLinks, getReadmesFromOrg } from "../src/github/gh_get_links";
import { checkLinks } from "../src/link";
import { filterOutIrrelevantLinks, getLinksFromPages } from "../src/page";
import { getWebsitePages } from "../src/sitemap";
import type { Link, LinkWithResult } from "../src/types";
import { getErrorMessage } from "../src/utils/errors";
import { createPrefixFilter } from "../src/website";
import { summarizeComposition } from "./composition";
import { proportionalSample } from "./sample";
import type { Corpus, CorpusLink, CorpusSource } from "./types";

const DEV_URL = "https://dev.fingerprint.com";
const WEB_URL = "https://fingerprint.com";
const WEB_INCLUDE = [DEV_URL, WEB_URL, "https://github.com"];
const GITHUB_ORG = "fingerprintjs";

// Fraction of page groups kept per source (see `proportionalSample`). Tuned so a benchmark round stays in the
// 45-90s range on a CI runner: it's fine (and expected) if this keeps only a handful of Playwright pages, the
// sample is meant to represent the whole population, not just its slowest phase (see README.md "Benchmark").
// Override with CORPUS_SAMPLE_RATE while tuning (actual request latency varies a lot by network, re-check the
// round time with `pnpm bench` after changing it, and keep the corpus file itself to a reasonable size).
const SAMPLE_RATE = Number(process.env.CORPUS_SAMPLE_RATE) || 0.08;

type SourcedLink = Link & { source: CorpusSource };

/** README links of the org, or `[]` if they can't be listed (e.g. no org-wide GitHub API access in this environment) */
const collectReadmeLinks = async (): Promise<Link[]> => {
  let readmes: Awaited<ReturnType<typeof getReadmesFromOrg>>;
  try {
    readmes = await getReadmesFromOrg(GITHUB_ORG);
  } catch (error) {
    console.warn(
      `Could not list README files of the ${GITHUB_ORG} org, corpus will not include README links: ${getErrorMessage(error)}`,
    );
    return [];
  }
  return filterOutIrrelevantLinks(await getReadmeLinks(readmes));
};

const withSource = (links: Link[], source: CorpusSource): SourcedLink[] =>
  links.map((link) => ({ ...link, source }));

const collectLinks = async (): Promise<SourcedLink[]> => {
  console.log("Reading sitemaps and README files...");
  const [devPages, webPages, readmeLinks] = await Promise.all([
    getWebsitePages(DEV_URL),
    getWebsitePages(WEB_URL),
    collectReadmeLinks(),
  ]);
  const { links: devLinks } = await getLinksFromPages({ pages: devPages });
  const { links: webLinks } = await getLinksFromPages({
    pages: webPages,
    linkFilter: createPrefixFilter(WEB_INCLUDE),
  });
  console.log(
    `Collected ${devLinks.length} dev.fingerprint.com + ${webLinks.length} fingerprint.com + ${readmeLinks.length} README links.`,
  );
  return [
    ...withSource(devLinks, "docs"),
    ...withSource(webLinks, "web"),
    ...withSource(readmeLinks, "github"),
  ];
};

const toCorpusLink = (link: LinkWithResult, source: CorpusSource): CorpusLink => ({
  page: link.page,
  href: link.href,
  text: link.text,
  source,
  // The first pass (fetch/github-api) always sets checkedWith for a non-recheck result, Playwright for the
  // rest (see src/link.ts): every link here went through checkLinks, so this is never missing in practice.
  checkedWith: link.checkedWith ?? "fetch",
  outcome: link.result.ok ? "ok" : link.result.error,
});

const main = async () => {
  const links = await collectLinks();
  console.log(`Checking ${links.length} links once to learn checkedWith and outcome...`);
  // checkLinks returns one result per input link, in the same order (see its `links.map(...)` return), so pairing
  // by index recovers the source tag without carrying it through checkLinks itself.
  const checked = await checkLinks({ links });
  const population = links.map((link, i) => {
    const result = checked[i];
    if (!result) {
      throw new Error(
        `checkLinks returned fewer results (${checked.length}) than links (${links.length}).`,
      );
    }
    return toCorpusLink(result, link.source);
  });

  const sampled = proportionalSample(population, (link) => link.source, SAMPLE_RATE);
  console.log(
    `Sampled ${sampled.length} of ${population.length} checked links (rate ${SAMPLE_RATE}).`,
  );

  const corpus: Corpus = {
    generatedAt: new Date().toISOString(),
    gitSha: execSync("git rev-parse HEAD").toString().trim(),
    sources: ["checkLinks:docs", "checkLinks:github", "checkLinks:web"],
    sampleRate: SAMPLE_RATE,
    population: summarizeComposition(population),
    sample: summarizeComposition(sampled),
    links: sampled,
  };

  const corpusPath = join(import.meta.dirname, "corpus.json");
  writeFileSync(corpusPath, `${JSON.stringify(corpus, null, 2)}\n`);
  console.log(`Wrote ${corpusPath}: ${corpus.links.length} links.`);
  console.log("Population:", corpus.population);
  console.log("Sample:", corpus.sample);
};

await main();
