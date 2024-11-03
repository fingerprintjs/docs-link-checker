import * as cheerio from "cheerio";
import { Link } from "./types";
import { BROWSER_USER_AGENT, parallelProcess, progressBar } from "./utils";

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
  ];
  return links.filter((link) => !patternsToFilterOut.some((pattern) => pattern.test(link.href)));
}

export async function parseLinksFromPage(pageUrl: string, pageHTML?: string): Promise<Link[]> {
  // Fetch page if HTML is not already provided
  let pageContent: string;
  if (pageHTML) {
    pageContent = pageHTML;
  } else {
    const response = await fetch(pageUrl, { headers: { "User-Agent": BROWSER_USER_AGENT } });
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
  progressBar.start(pages.length, 0);
  const { results, errors } = await parallelProcess(pages, async (page) => {
    return parseLinksFromPage(page);
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

  // Log errors
  if (errors.length > 0) {
    console.log(`Retrieving links failed for ${errors.length} pages.`);
  }
  if (verbose) {
    console.log(errors);
  }

  return { links, errors };
};
