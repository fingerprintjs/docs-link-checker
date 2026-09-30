import { type Baseline, EMPTY_BASELINE } from "./baseline";
import { checkLinks } from "./link";
import { getLinksFromPages } from "./page";
import { DEFAULT_OUTPUT_DIR, getJSONReport, saveReport } from "./report/report";
import { withRun } from "./run";
import { timePhase } from "./run_context";
import { getWebsitePages } from "./sitemap";
import type { Link } from "./types";
import { sampleItems } from "./utils";

export type CheckWebsiteArgs = {
  websiteUrl: string;
  linkFilter?: (link: Link) => boolean;
  usePlaywright?: boolean;
  /** Share of sitemap pages to check (0-1), defaults to `LINK_CHECK_SAMPLE_RATE` */
  sampleRate?: number;
  /** Failing links matching the baseline are reported as ignored */
  baseline?: Baseline;
  /** Where to save the JSON and HTML reports, `false` to not save them. Default `results` */
  outputDir?: string | false;
};

/** Link filter keeping only links starting with one of the prefixes (`site --include`) */
export const createPrefixFilter =
  (prefixes: string[]) =>
  (link: Link): boolean =>
    prefixes.some((prefix) => link.href.startsWith(prefix));

/**
 * Checks links on all pages of a website (from its sitemap).
 * Runs as a single run (see `withRun`): the shared browser is closed and metrics are logged at the end.
 */
export const checkWebsite = ({
  websiteUrl,
  linkFilter,
  usePlaywright,
  sampleRate,
  baseline = EMPTY_BASELINE,
  outputDir = DEFAULT_OUTPUT_DIR,
}: CheckWebsiteArgs) =>
  withRun(async () => {
    const startTime = performance.now();

    const allPages = await timePhase("Read sitemap", () => getWebsitePages(websiteUrl, true));
    const pages = sampleItems({
      items: allPages,
      key: (page) => page,
      rate: sampleRate,
      label: "pages",
    });

    const { links } = await timePhase("Extract links", () =>
      getLinksFromPages({ pages, linkFilter, usePlaywright }),
    );
    console.log(`Fetched ${links.length} links.`);

    const { results, errors } = await checkLinks({ links });

    const report = getJSONReport({
      links: results,
      errors,
      siteName: new URL(websiteUrl).hostname,
      baseline,
    });
    if (outputDir !== false) {
      saveReport(report, outputDir);
    }
    console.log(report.summary);

    console.log(`Finished in ${(performance.now() - startTime) / 1000} seconds.`);
    return report;
  });
