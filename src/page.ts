import * as cheerio from "cheerio";
import { fetchWithHostLimit, USER_AGENT } from "./http";
import { getTerminal } from "./run";
import type { Link } from "./types";
import { parallelProcess } from "./utils";

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

export function filterOutIrrelevantLinks(links: Link[]): Link[] {
  return links.filter(
    (link) =>
      isHttpUrl(link.href) &&
      !isHostToFilterOut(link.href) &&
      !patternsToFilterOut.some((pattern) => pattern.test(link.href)),
  );
}

/**
 * Parses links from a single page. Relative links are resolved against `pageUrl` (the sitemap URL), not the redirected URL.
 * @throws {Error} if the page can't be fetched, so it shows up in the extraction errors instead of silently having no links
 */
async function parseLinksFromPage(pageUrl: string): Promise<Link[]> {
  // Limited per host (like link checks), with a request timeout. A 429 with Retry-After pauses the host and is retried.
  const response = await fetchWithHostLimit(
    pageUrl,
    { headers: { "User-Agent": USER_AGENT } },
    async (res) => (res.ok ? res.text() : ""),
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Could not fetch ${pageUrl}, status: ${response.status}`);
  }
  const pageContent = response.data;

  // Parse links from page HTML
  const $ = cheerio.load(pageContent, { baseURI: pageUrl });
  const links = $("a");
  const result: Link[] = [];
  links.each((_index, value) => {
    const href = value.attribs.href;
    if (href) {
      // Resolves both absolute and relative links (relative to pageUrl)
      result.push({ href: new URL(href, pageUrl).href, text: $(value).text(), page: pageUrl });
    }
  });

  return filterOutIrrelevantLinks(result);
}

/**
 * Parses links from multiple pages
 * @param pages
 * @param linkFilter Filter function to apply to links
 * @returns
 */
export const getLinksFromPages = async ({
  pages,
  linkFilter,
}: {
  pages: string[];
  linkFilter?: (link: Link) => boolean;
}) => {
  // Parse links from pages
  const { results, errors } = await parallelProcess({
    items: pages,
    label: "Reading pages",
    processFn: async (page: string) => parseLinksFromPage(page),
  });

  // Flatten and filter results if a link filter is provided
  const flatResults = results.flat();
  const links = linkFilter ? flatResults.filter(linkFilter) : flatResults;
  if (linkFilter) {
    getTerminal().verbose(
      `Filtered away ${flatResults.length - links.length} links using the provided links filter.`,
    );
  }

  if (errors.length > 0) {
    getTerminal().verbose(`Retrieving links failed for ${errors.length} pages.`);
  }

  return { links, errors };
};
