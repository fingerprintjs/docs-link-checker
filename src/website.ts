import { getLinksFromPages } from "./page";

import { checkLinks } from "./link";
import { getJSONReport, saveReport } from "./report/report";
import { getWebsitePages } from "./sitemap";
import { Link } from "./types";

type CheckWebsiteArgs = {
  websiteUrl: string;
  linkFilter?: (link: Link) => boolean;
  usePlaywright?: boolean;
};

export const checkWebsite = async ({ websiteUrl, linkFilter, usePlaywright }: CheckWebsiteArgs) => {
  const startTime = performance.now();

  const pages = await getWebsitePages(websiteUrl, true);
  if (pages.length === 0) {
    throw new Error(`No pages discovered for ${websiteUrl}. Sitemap discovery likely failed.`);
  }

  const { links } = await getLinksFromPages({ pages, linkFilter, usePlaywright });
  if (links.length === 0) {
    throw new Error(`No links discovered for ${websiteUrl}. Link extraction likely failed.`);
  }
  console.log(`Fetched ${links.length} links.`);

  const { results, errors } = await checkLinks({ links });

  const report = getJSONReport({ links: results, errors, siteName: new URL(websiteUrl).hostname });
  saveReport(report);
  console.log(report.summary);

  console.log(`Finished in ${(performance.now() - startTime) / 1000} seconds.`);
  return report;
};
