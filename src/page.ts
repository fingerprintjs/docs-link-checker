import * as cheerio from "cheerio";
import { Link } from "./types";
import {
  getRandomUserAgent,
  parallelProcess,
  PLAYWRIGHT_CONCURRENCY_LIMIT,
  progressBar,
} from "./utils";
import { chromium } from "playwright";

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
    /cdn-cgi\/l\/email\-protection/,
    // dash.cloudflare.com (Requires login)
    /^https:\/\/dash\.cloudflare\.com/,
    // Readme sends the internal link syntax from the server only updates it with JavaScript client-side 🤦
    /^doc:/,
    /^ref:/,
    // And other readme bugs
    /^https:\/\/dev\.fingerprint\.com\/recipes/,
    /^https:\/\/dev\.fingerprint\.com\/discuss/,
  ];
  return links.filter((link) => !patternsToFilterOut.some((pattern) => pattern.test(link.href)));
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
    const response = await fetch(pageUrl, { headers: { "User-Agent": getRandomUserAgent() } });
    if (!response.ok) {
      console.error(`Could not fetch ${pageUrl}! status: ${response.status}`);
      return [];
    }
    pageContent = await response.text();
  }

  // Parse links from page HTML
  const $ = cheerio.load(pageContent, { baseURI: pageUrl });
  const links = $("a");
  const result: Link[] = [];
  links.each((index, value) => {
    const href = value.attribs.href;
    if (href) {
      if (href.startsWith("http")) {
        // Handle absolute links
        result.push({ href, text: $(value).text(), page: pageUrl });
      } else {
        // Handle relative links
        result.push({
          href: new URL(href, pageUrl).href,
          text: $(value).text(),
          page: pageUrl,
        });
      }
    }
  });

  return filterOutIrrelevantLinks(result);
}

/**
 * Parses links from multiple pages
 * @param pages
 * @param verbose
 * @param linkFilter Filter function to apply to links
 * @param usePlaywright
 * @returns
 */
export const getLinksFromPages = async ({
  pages,
  verbose = false,
  linkFilter,
  usePlaywright = false,
}: {
  pages: string[];
  verbose?: boolean;
  linkFilter?: (link: Link) => boolean;
  usePlaywright?: boolean;
}) => {
  console.log(`Retrieving links from ${pages.length} pages...`);
  // Parse links from pages
  progressBar.start(pages.length, 0);
  const { results, errors } = await parallelProcess({
    items: pages,
    processFn: async (page: string) => {
      return usePlaywright ? parseLinksFromPageWithPlaywright(page) : parseLinksFromPage(page);
    },
    concurrencyLimit: usePlaywright ? PLAYWRIGHT_CONCURRENCY_LIMIT : undefined,
  });

  // Flatten and filter results if a link filter is provided
  const flatResults = results.flat();
  console.log(`Extracted ${flatResults.length} links.`);
  const links = linkFilter ? flatResults.filter(linkFilter) : flatResults;
  if (linkFilter) {
    console.log(
      `Filtered away ${flatResults.length - links.length} links using the provided links filter. Continuing with ${
        links.length
      } links...`
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

/**
 * Not used right now, might be useful if you need to parse links from a client-rendered page
 * @param pageUrl
 * @returns
 */
export const parseLinksFromPageWithPlaywright = async (pageUrl: string): Promise<Link[]> => {
  // Launch the browser
  const browser = await chromium.launch({
    headless: true,
  });

  try {
    // Create a new page
    const page = await browser.newPage();

    // Navigate to the URL
    const response = await page.goto(pageUrl, {
      timeout: 30000, // 30 second timeout
    });

    if (!response?.ok()) {
      console.error(`Could not fetch ${pageUrl} status: ${response?.status()}`);
      return [];
    }

    await page.waitForSelector(".markdown-body");

    // Extract all links using page.evaluate
    const links = await page.evaluate(
      ([pageUrl]) => {
        // Get all 'a' elements (but not anchor icons) inside article content
        const anchors = document.querySelectorAll<HTMLAnchorElement>(".markdown-body a:not(.fa-anchor)");

        // Convert NodeList to array and map to desired format
        return Array.from(anchors).map((anchor) => ({
          page: pageUrl,
          href: anchor.href,
          text: anchor.textContent?.trim() ?? "",
        }));
      },
      [pageUrl]
    );

    return filterOutIrrelevantLinks(links);
  } catch (error) {
    console.error("Error occurred while scraping:", error);
    throw error;
  } finally {
    // Always close the browser
    await browser.close();
  }
};


