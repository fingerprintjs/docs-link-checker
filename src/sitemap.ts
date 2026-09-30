import * as cheerio from "cheerio";
import { getRandomUserAgent, log } from "./utils";

// How deep nested sitemap indexes are followed (sitemap index -> sitemap index -> ... -> sitemap)
export const MAX_SITEMAP_DEPTH = 3;

/**
 * Retrieves all the pages from a website by fetching the sitemap and parsing it.
 *
 * @param {string} url - The URL of the website.
 * @param {boolean} [verbose=false] - Whether to log the progress of the function.
 * @return {Promise<string[]>} - A promise that resolves to an array of unique page URLs.
 */
export const getWebsitePages = async (url: string, verbose = false) => {
  const sitemaps = await getWebsiteSitemaps(url, verbose);
  // Shared between all sitemaps, so each sitemap is fetched only once
  const visitedSitemaps = new Set<string>();
  const pages = (
    await Promise.all(
      // Not verbose, that would log every page
      sitemaps.map((sitemap) => getPagesFromSitemap(sitemap, false, 0, visitedSitemaps))
    )
  ).flat();

  return [...new Set(pages)];
};

/**
 * Retrieves the all sitemaps from the websites sitemap-index or a single sitemap, whatever the website has.
 *
 * @param {string} url - The URL of the website.
 * @param {boolean} [verbose=false] - Whether to log the progress.
 * @return {Promise<string[]>} - A promise that resolves to an array of sitemap URLs.
 */
export const getWebsiteSitemaps = async (url: string, verbose = false): Promise<string[]> => {
  const sitemapExists = (
    await fetch(`${url}/sitemap.xml`, {
      headers: { "User-Agent": getRandomUserAgent() },
    })
  ).ok;
  if (sitemapExists) {
    log("Sitemap.xml exists, parsing pages from it", verbose);
    return [`${url}/sitemap.xml`];
  }

  const sitemapIndex = await (
    await fetch(`${url}/sitemap-index.xml`, {
      headers: { "User-Agent": getRandomUserAgent() },
    })
  ).text();
  if (!sitemapIndex) {
    console.error("No sitemap.xml or sitemap-index.xml found");
    return [];
  }

  const sitemaps: string[] = getSitemapsFromSitemapIndex(sitemapIndex);
  log(`Retrieved ${sitemaps.length} sitemaps from sitemap-index.xml`, verbose);
  return sitemaps;
};

/**
 * Retrieves an array of sitemap URLs from a sitemap index XML file.
 *
 * @param {string} sitemapIndexXml - The content of the sitemap index XML file.
 * @return {string[]} An array of sitemap URLs.
 */
function getSitemapsFromSitemapIndex(sitemapIndexXml: string) {
  const $ = cheerio.load(sitemapIndexXml, { xmlMode: true });
  const sitemaps: string[] = [];
  $("sitemap").each((_, sitemapElem) => {
    const location = $(sitemapElem).find("loc").text().trim();
    if (location) {
      sitemaps.push(location);
    }
  });
  return sitemaps;
}

/**
 * Retrieves pages from a sitemap URL and logs the number of pages retrieved.
 * If the sitemap is a sitemap index (`<sitemapindex>`), the nested sitemaps are followed recursively
 * (up to `MAX_SITEMAP_DEPTH`, each sitemap is fetched only once).
 *
 * @param {string} sitemapUrl - The URL of the sitemap.
 * @param {boolean} [verbose=false] - Whether to log the progress.
 * @return {string[]} An array of unique page URLs retrieved from the sitemap.
 */
export const getPagesFromSitemap = async (
  sitemapUrl: string,
  verbose = false,
  depth = 0,
  visitedSitemaps = new Set<string>()
): Promise<string[]> => {
  if (visitedSitemaps.has(sitemapUrl)) {
    log(`Skipping already visited sitemap ${sitemapUrl}`, verbose);
    return [];
  }
  visitedSitemaps.add(sitemapUrl);

  const sitemapResponse = await fetch(sitemapUrl, { headers: { "User-Agent": getRandomUserAgent() } });
  // Fail loudly, silently skipping a sitemap would skip all of its pages
  if (!sitemapResponse.ok) {
    throw new Error(`Could not fetch sitemap ${sitemapUrl}: status ${sitemapResponse.status}`);
  }
  const response = await sitemapResponse.text();
  const $ = cheerio.load(response, { xmlMode: true });

  if ($("sitemapindex").length > 0) {
    if (depth >= MAX_SITEMAP_DEPTH) {
      console.warn(`Sitemap index ${sitemapUrl} is nested too deep (max depth ${MAX_SITEMAP_DEPTH}), skipping it.`);
      return [];
    }
    const nestedSitemaps = getSitemapsFromSitemapIndex(response);
    log(`${sitemapUrl} is a sitemap index with ${nestedSitemaps.length} sitemaps`, verbose);
    const nestedPages = (
      await Promise.all(
        nestedSitemaps.map((nested) => getPagesFromSitemap(nested, verbose, depth + 1, visitedSitemaps))
      )
    ).flat();
    return [...new Set(nestedPages)];
  }

  const pages: string[] = [];
  $("url").each((_, urlElem) => {
    const location = $(urlElem).find("loc").text().trim();
    if (location) {
      pages.push(location);
    }
  });
  const uniquePages = [...new Set(pages)];

  console.log(`Retrieved ${uniquePages.length} pages from ${sitemapUrl} sitemap.`);
  log(uniquePages, verbose);
  return uniquePages;
};
