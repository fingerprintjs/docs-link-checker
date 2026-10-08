/**
 * `site` command: checks the links on all pages of a website (from its sitemap).
 */
import { Effect } from "effect";
import { checkLinks } from "./link";
import { Metrics } from "./metrics";
import { getLinksFromPages } from "./page";
import { getWebsitePages } from "./sitemap";
import type { Link } from "./types";
import { sampleItems } from "./utils";

/** Link filter keeping only links starting with one of the prefixes (`site --include`) */
export const createPrefixFilter =
  (prefixes: ReadonlyArray<string>) =>
  (link: Link): boolean =>
    prefixes.some((prefix) => link.href.startsWith(prefix));

/** Checks links on all pages of a website (from its sitemap) */
export const checkWebsite = Effect.fn("website.checkWebsite")(function* ({
  websiteUrl,
  linkFilter,
  sampleRate,
}: {
  readonly websiteUrl: string;
  readonly linkFilter?: (link: Link) => boolean;
  /** Share of sitemap pages to check (0-1) */
  readonly sampleRate: number;
}) {
  const metrics = yield* Metrics;
  const allPages = yield* metrics.timePhase("Read sitemap", getWebsitePages(websiteUrl));
  const pages = yield* sampleItems({
    items: allPages,
    key: (page) => page,
    rate: sampleRate,
    label: "pages",
  });

  const { links } = yield* metrics.timePhase(
    "Extract links",
    getLinksFromPages({ pages, linkFilter }),
  );
  yield* Effect.logInfo(`Fetched ${links.length} links.`);

  return yield* checkLinks({ links });
});
