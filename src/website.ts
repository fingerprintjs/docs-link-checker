import { getLinksFromPages } from "./page";

import { checkLinks } from "./link";
import { getJSONReport, saveReport } from "./report/report";
import { getWebsitePages } from "./sitemap";
import { Link } from "./types";
import { sampleItems } from "./utils";
import { withRun } from "./run";
import { timePhase } from "./run_context";

type CheckWebsiteArgs = {
  websiteUrl: string;
  linkFilter?: (link: Link) => boolean;
  usePlaywright?: boolean;
};

/**
 * Checks links on all pages of a website (from its sitemap).
 * Runs as a single run (see `withRun`): the shared browser is closed and metrics are logged at the end.
 */
export const checkWebsite = ({ websiteUrl, linkFilter, usePlaywright }: CheckWebsiteArgs) =>
  withRun(async () => {
    const startTime = performance.now();

    const allPages = await timePhase("Read sitemap", () => getWebsitePages(websiteUrl, true));
    const pages = sampleItems({ items: allPages, key: (page) => page, label: "pages" });

    const { links } = await timePhase("Extract links", () => getLinksFromPages({ pages, linkFilter, usePlaywright }));
    console.log(`Fetched ${links.length} links.`);

    const { results, errors } = await checkLinks({ links });

    const report = getJSONReport({ links: results, errors, siteName: new URL(websiteUrl).hostname });
    saveReport(report);
    console.log(report.summary);

    console.log(`Finished in ${(performance.now() - startTime) / 1000} seconds.`);
    return report;
  });
