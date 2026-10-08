/**
 * Links of website pages and the filter of links that are not worth checking.
 */
import * as cheerio from "cheerio";
import { Effect } from "effect";
import { HttpStatusError } from "./errors";
import { fetchLimited, USER_AGENT } from "./http";
import type { Link } from "./types";
import { processAll } from "./utils";

// Only http(s) links can be checked, skip `tel:`, `javascript:`, `data:` and other schemes
const isHttpUrl = (href: string) => {
  try {
    return ["http:", "https:"].includes(new URL(href).protocol);
  } catch {
    // Unparsable URLs are kept, they are reported as broken links
    return true;
  }
};

// Compared with the parsed host, a regex on the raw URL also matches `portal.azure.com.example.com`
const hostsToFilterOut = [
  // Gives 500 and redirects to the native app store
  "apps.apple.com",
  // Requires login, also regional subdomains (`eu-west-1.console.aws.amazon.com`)
  "console.aws.amazon.com",
  // Requires login
  "portal.azure.com",
  "dash.cloudflare.com",
];

const patternsToFilterOut = [
  // Not a real page, tied to the path and not to the host
  /cdn-cgi\/l\/email-protection/,
  // Readme sends the internal link syntax from the server only updates it with JavaScript client-side 🤦
  /^doc:/,
  /^ref:/,
  // And other readme bugs
  /^https:\/\/dev\.fingerprint\.com\/recipes/,
  /^https:\/\/dev\.fingerprint\.com\/discuss/,
];

const isHostToFilterOut = (href: string) => {
  const { hostname } = URL.canParse(href) ? new URL(href) : { hostname: "" };
  return (
    hostname === "localhost" ||
    hostsToFilterOut.some((host) => hostname === host || hostname.endsWith(`.${host}`))
  );
};

export const filterOutIrrelevantLinks = (links: ReadonlyArray<Link>): Link[] => {
  return links.filter(
    (link) =>
      isHttpUrl(link.href) &&
      !isHostToFilterOut(link.href) &&
      !patternsToFilterOut.some((pattern) => pattern.test(link.href)),
  );
};

/**
 * Parses links from a single page. Relative links are resolved against `pageUrl` (the sitemap URL), not the
 * redirected URL. Fails if the page can't be fetched, so it shows up in the extraction errors instead of
 * silently having no links.
 */
const parseLinksFromPage = Effect.fn("page.parseLinksFromPage")(function* (pageUrl: string) {
  const response = yield* fetchLimited(pageUrl, { headers: { "User-Agent": USER_AGENT } }, (res) =>
    res.ok ? res.text() : Promise.resolve(""),
  );
  if (response.status < 200 || response.status >= 300) {
    return yield* new HttpStatusError({
      url: pageUrl,
      status: response.status,
      message: `Could not fetch ${pageUrl}, status: ${response.status}`,
    });
  }

  const $ = cheerio.load(response.data, { baseURI: pageUrl });
  const links: Link[] = [];
  $("a").each((_index, anchor) => {
    const href = anchor.attribs.href;
    if (href) {
      // Resolves both absolute and relative links (relative to pageUrl)
      links.push({ href: new URL(href, pageUrl).href, text: $(anchor).text(), page: pageUrl });
    }
  });
  return filterOutIrrelevantLinks(links);
});

/**
 * Links of all pages, filtered with `linkFilter` if given. A page that fails is an error entry,
 * the other pages are still read.
 */
export const getLinksFromPages = Effect.fn("page.getLinksFromPages")(function* ({
  pages,
  linkFilter,
}: {
  readonly pages: ReadonlyArray<string>;
  readonly linkFilter?: (link: Link) => boolean;
}) {
  yield* Effect.logInfo(`Retrieving links from ${pages.length} pages...`);
  const { results, errors } = yield* processAll({ items: pages, process: parseLinksFromPage });

  const allLinks = results.flat();
  yield* Effect.logInfo(`Extracted ${allLinks.length} links.`);
  const links = linkFilter ? allLinks.filter(linkFilter) : allLinks;
  if (linkFilter) {
    yield* Effect.logInfo(
      `Filtered away ${allLinks.length - links.length} links using the provided links filter. Continuing with ${links.length} links...`,
    );
  }
  if (errors.length > 0) {
    yield* Effect.logInfo(`Retrieving links failed for ${errors.length} pages.`);
  }
  return { links, errors };
});
