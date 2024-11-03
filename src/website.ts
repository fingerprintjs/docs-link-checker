import { getLinksFromPages } from "./page";

import { checkLinks } from "./link";
import { getJSONReport, saveReport } from "./report/report";
import { getWebsitePages } from "./sitemap";
import { Link } from "./types";

type CheckWebsiteArgs = {
  websiteUrl: string;
  linkFilter?: (link: Link) => boolean;
};

export const checkWebsite = async ({ websiteUrl, linkFilter }: CheckWebsiteArgs) => {
  const startTime = performance.now();

  const pages = await getWebsitePages(websiteUrl, true);
  const { links } = await getLinksFromPages({ pages, linkFilter });
  const { results, errors } = await checkLinks({ links });

  const report = getJSONReport({ links: results, errors, siteName: new URL(websiteUrl).hostname });
  saveReport(report);
  console.log(report.summary);

  console.log(`Finished in ${(performance.now() - startTime) / 1000} seconds.`);
  return report;
};
