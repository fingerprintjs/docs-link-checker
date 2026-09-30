import { getLinksFromPages } from "./page";

import { checkLinks } from "./link";
import { getJSONReport, saveReport } from "./report/report";
import { getWebsitePages } from "./sitemap";
import { Link } from "./types";
import { sampleItems } from "./utils";

type CheckWebsiteArgs = {
  websiteUrl: string;
  linkFilter?: (link: Link) => boolean;
  usePlaywright?: boolean;
};

export const checkWebsite = async ({ websiteUrl, linkFilter, usePlaywright }: CheckWebsiteArgs) => {
  const startTime = performance.now();

  const allPages = await getWebsitePages(websiteUrl, true);
  const pages = sampleItems({ items: allPages, key: (page) => page, label: "pages" });

  const { links } = await getLinksFromPages({ pages, linkFilter, usePlaywright });
  console.log(`Fetched ${links.length} links.`);

  const { results, errors } = await checkLinks({ links });

  const report = getJSONReport({ links: results, errors, siteName: new URL(websiteUrl).hostname });
  saveReport(report);
  console.log(report.summary);

  console.log(`Finished in ${(performance.now() - startTime) / 1000} seconds.`);
  return report;
};
