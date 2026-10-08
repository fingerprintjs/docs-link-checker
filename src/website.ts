import { checkLinks } from "./link";
import { getLinksFromPages } from "./page";
import { timePhase } from "./run";
import { getWebsitePages } from "./sitemap";
import type { Link, LinkWithResult } from "./types";
import { sampleItems } from "./utils";

export type CheckWebsiteArgs = {
  websiteUrl: string;
  linkFilter?: (link: Link) => boolean;
  /** Share of sitemap pages to check (0-1), defaults to `LINK_CHECK_SAMPLE_RATE` */
  sampleRate?: number;
};

/** Link filter keeping only links starting with one of the prefixes (`site --include`) */
export const createPrefixFilter =
  (prefixes: string[]) =>
  (link: Link): boolean =>
    prefixes.some((prefix) => link.href.startsWith(prefix));

/**
 * Checks links on all pages of a website (from its sitemap).
 * Must run inside `runCommand` (`src/cli.ts`), which builds the report.
 */
export const checkWebsite = async ({
  websiteUrl,
  linkFilter,
  sampleRate,
}: CheckWebsiteArgs): Promise<LinkWithResult[]> => {
  const allPages = await timePhase("Read sitemap", () => getWebsitePages(websiteUrl));
  const pages = sampleItems({
    items: allPages,
    key: (page) => page,
    rate: sampleRate,
    label: "pages",
  });

  const { links } = await timePhase("Extract links", () =>
    getLinksFromPages({ pages, linkFilter }),
  );
  console.log(`Fetched ${links.length} links.`);

  return checkLinks({ links });
};
