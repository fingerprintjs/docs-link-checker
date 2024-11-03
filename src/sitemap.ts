import * as cheerio from "cheerio";
import { BROWSER_USER_AGENT, log } from "./utils";

/**
 * Retrieves all the pages from a website by fetching the sitemap and parsing it.
 *
 * @param {string} url - The URL of the website.
 * @param {boolean} [verbose=false] - Whether to log the progress of the function.
 * @return {Promise<string[]>} - A promise that resolves to an array of page URLs.
 */
export const getWebsitePages = async (url: string, verbose = false) => {
  const sitemaps = await getWebsiteSitemaps(url, verbose);
  const pages = await (
    await Promise.all(
      sitemaps.map(async (sitemap) => await getPagesFromSitemap(sitemap))
    )
  ).flat();

  return pages;
};

/**
 * Retrieves the all sitemaps from the websites sitemap-index or a single sitemap, whatever the website has.
 *
 * @param {string} url - The URL of the website.
 * @param {boolean} [verbose=false] - Whether to log the progress.
 * @return {Promise<string[]>} - A promise that resolves to an array of sitemap URLs.
 */
export const getWebsiteSitemaps = async (
  url: string,
  verbose = false
): Promise<string[]> => {
  const sitemapExists = await(
    await fetch(`${url}/sitemap.xml`, {
      headers: { "User-Agent": BROWSER_USER_AGENT },
    })
  ).ok;
  if (sitemapExists) {
    log("Sitemap.xml exists, parsing pages from it", verbose);
    return [`${url}/sitemap.xml`];
  }

  const sitemapIndex = await(
    await fetch(`${url}/sitemap-index.xml`, {
      headers: { "User-Agent": BROWSER_USER_AGENT },
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
 * @param {string} sitemapIndexUrl - The URL of the sitemap index XML file.
 * @return {string[]} An array of sitemap URLs.
 */
function getSitemapsFromSitemapIndex(sitemapIndexUrl: string) {
  const $ = cheerio.load(sitemapIndexUrl, { xmlMode: true });
  const sitemaps: string[] = [];
  $("sitemap").each((_, sitemapElem) => {
    const location = $(sitemapElem).find("loc").text();
    sitemaps.push(location);
  });
  return sitemaps;
}

/**
 * Retrieves pages from a sitemap URL and logs the number of pages retrieved.
 *
 * @param {string} sitemapUrl - The URL of the sitemap.
 * @param {boolean} [verbose=false] - Whether to log the progress.
 * @return {string[]} An array of page URLs retrieved from the sitemap.
 */
export const getPagesFromSitemap = async (
  sitemapUrl: string,
  verbose = false
) => {
  const response = await(
    await fetch(sitemapUrl, { headers: { "User-Agent": BROWSER_USER_AGENT } })
  ).text();
  const $ = cheerio.load(response, { xmlMode: true });
  const pages: string[] = [];
  $("url").each((_, urlElem) => {
    const location = $(urlElem).find("loc").text();
    pages.push(location);
  });

  console.log(`Retrieved ${pages.length} pages from ${sitemapUrl} sitemap.`);
  log(pages, verbose);
  return pages;
};
