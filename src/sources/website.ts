import { checkLinks } from "../check/link";
import { getTerminal, timePhase } from "../run";
import { plural } from "../terminal";
import type { Link, LinkWithResult } from "../types";
import { sampleItems } from "../utils/parallel";
import { getLinksFromPages } from "./page";
import { getWebsitePages } from "./sitemap";

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
  getTerminal().done(`Found ${plural(links.length, "link")} in ${plural(pages.length, "page")}`);

  return checkLinks({ links });
};
