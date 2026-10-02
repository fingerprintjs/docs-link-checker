import * as cheerio from "cheerio";
import { fetchWithHostLimit } from "./http";
import type { Link } from "./types";
import { getRandomUserAgent, parallelProcess } from "./utils";

// Only http(s) links can be checked, skip `tel:`, `javascript:`, `data:` and other schemes
const isHttpUrl = (href: string) => {
  try {
    return ["http:", "https:"].includes(new URL(href).protocol);
  } catch {
    // Unparsable URLs are kept, they are reported as broken links
    return true;
  }
};

export function filterOutIrrelevantLinks(links: Link[]): Link[] {
  const patternsToFilterOut = [
    // Localhost
    /^http:\/\/localhost/,
    // Starts with mailto:
    /^mailto:/,
    // Starts with https://apps.apple.com/ (gives 500 and redirects to native app store)
    /^https:\/\/apps\.apple\.com/,
    // includes `console.aws.amazon.com` (Requires login)
    /console\.aws\.amazon\.com/,
    // https://portal.azure.com (Requires login)
    /^https:\/\/portal\.azure\.com/,
    // Included Cloudflare email link protection pattern like cdn-cgi/l/email-protection#1e6d6b6e6e716c6a5e787770797b6c6e6c77706a307d7173216d6b7c747b7d6a23573b2c2e697f706a3b2c2e6a713b2c2e757b7b6e3b2c2e544d3b2c2e5f797b706a3b2c2e7d717a7b3b2c2e71703b2c2e73673b2c2e6d7b6c687b6c
    /cdn-cgi\/l\/email-protection/,
    // dash.cloudflare.com (Requires login)
    /^https:\/\/dash\.cloudflare\.com/,
    // Readme sends the internal link syntax from the server only updates it with JavaScript client-side 🤦
    /^doc:/,
    /^ref:/,
    // And other readme bugs
    /^https:\/\/dev\.fingerprint\.com\/recipes/,
    /^https:\/\/dev\.fingerprint\.com\/discuss/,
  ];
  return links.filter(
    (link) =>
      isHttpUrl(link.href) && !patternsToFilterOut.some((pattern) => pattern.test(link.href)),
  );
}

/**
 * Parses links from a single page
 * @param pageUrl
 * @param pageHTML
 * @returns
 */
export async function parseLinksFromPage(pageUrl: string, pageHTML?: string): Promise<Link[]> {
  // Fetch page if HTML is not already provided
  let pageContent: string;
  if (pageHTML) {
    pageContent = pageHTML;
  } else {
    // Limited per host (like link checks), with a request timeout. A 429 with Retry-After pauses the host and is retried.
    // Relative links are resolved against `pageUrl` (the sitemap URL), not the redirected URL, as before
    const response = await fetchWithHostLimit(
      pageUrl,
      { headers: { "User-Agent": getRandomUserAgent() } },
      async (res) => (res.ok ? res.text() : ""),
    );
    if (response.status < 200 || response.status >= 300) {
      // Thrown (not an empty list), so the page shows up in the extraction errors instead of silently having no links
      throw new Error(`Could not fetch ${pageUrl}, status: ${response.status}`);
    }
    pageContent = response.data;
  }

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
 * @param verbose
 * @param linkFilter Filter function to apply to links
 * @returns
 */
export const getLinksFromPages = async ({
  pages,
  verbose = false,
  linkFilter,
}: {
  pages: string[];
  verbose?: boolean;
  linkFilter?: (link: Link) => boolean;
}) => {
  console.log(`Retrieving links from ${pages.length} pages...`);
  // Parse links from pages
  const { results, errors } = await parallelProcess({
    items: pages,
    processFn: async (page: string) => parseLinksFromPage(page),
    // Tasks can wait for a per-host slot, every request has its own timeout instead
    taskTimeout: null,
  });

  // Flatten and filter results if a link filter is provided
  const flatResults = results.flat();
  console.log(`Extracted ${flatResults.length} links.`);
  const links = linkFilter ? flatResults.filter(linkFilter) : flatResults;
  if (linkFilter) {
    console.log(
      `Filtered away ${flatResults.length - links.length} links using the provided links filter. Continuing with ${
        links.length
      } links...`,
    );
  }

  if (errors.length > 0) {
    console.log(`Retrieving links failed for ${errors.length} pages.`);
  }
  if (verbose) {
    console.log(errors);
  }

  return { links, errors };
};
