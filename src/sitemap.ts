import * as cheerio from "cheerio";
import pLimit from "p-limit";
import { fetchWithHostLimit, getRandomUserAgent } from "./http";

// How deep nested sitemap indexes are followed (sitemap index -> sitemap index -> ... -> sitemap)
export const MAX_SITEMAP_DEPTH = 3;
// How many sitemaps are fetched at the same time (sitemap indexes can list thousands of sitemaps)
export const SITEMAP_FETCH_CONCURRENCY = 5;

const sitemapFetchSlots = pLimit(SITEMAP_FETCH_CONCURRENCY);

// Sitemaps can be large, give them more time than a regular page
const SITEMAP_FETCH_TIMEOUT = 60000;

const isSuccess = (status: number) => status >= 200 && status < 300;

/**
 * Fetches a sitemap: at most `SITEMAP_FETCH_CONCURRENCY` at the same time overall, and within the per-host limit
 * (`LINK_CHECK_HOST_CONCURRENCY`, with 429 Retry-After handling and redirects, see `fetchWithHostLimit`).
 * @returns the status and the body (empty if `readBody` is false or the response is not successful)
 */
const fetchSitemap = (sitemapUrl: string, readBody = true) =>
  sitemapFetchSlots(() =>
    fetchWithHostLimit(
      sitemapUrl,
      { headers: { "User-Agent": getRandomUserAgent() }, timeoutMs: SITEMAP_FETCH_TIMEOUT },
      // Failed responses are not read, fetchWithHostLimit cancels their body
      async (response) => (readBody && response.ok ? response.text() : ""),
    ),
  );

/**
 * Retrieves all the pages from a website by fetching the sitemap and parsing it.
 *
 * @param {string} url - The URL of the website.
 * @return {Promise<string[]>} - A promise that resolves to an array of unique page URLs.
 */
export const getWebsitePages = async (url: string) => {
  const sitemaps = await getWebsiteSitemaps(url);
  // Shared between all sitemaps, so each sitemap is only processed once
  const visited = new Set<string>();
  const pages = (
    await Promise.all(sitemaps.map((sitemap) => getPagesFromSitemap(sitemap, 0, visited)))
  ).flat();

  return [...new Set(pages)];
};

/**
 * Retrieves the all sitemaps from the websites sitemap-index or a single sitemap, whatever the website has.
 *
 * @param {string} url - The URL of the website.
 * @return {Promise<string[]>} - A promise that resolves to an array of sitemap URLs.
 */
const getWebsiteSitemaps = async (url: string): Promise<string[]> => {
  const sitemapExists = isSuccess((await fetchSitemap(`${url}/sitemap.xml`, false)).status);
  if (sitemapExists) {
    console.log("Sitemap.xml exists, parsing pages from it");
    return [`${url}/sitemap.xml`];
  }

  const sitemapIndex = (await fetchSitemap(`${url}/sitemap-index.xml`)).data;
  if (!sitemapIndex) {
    console.error("No sitemap.xml or sitemap-index.xml found");
    return [];
  }

  const sitemaps: string[] = getSitemapsFromSitemapIndex(sitemapIndex);
  console.log(`Retrieved ${sitemaps.length} sitemaps from sitemap-index.xml`);
  return sitemaps;
};

/**
 * Retrieves an array of sitemap URLs from a sitemap index XML file.
 *
 * @param {string} sitemapIndexXml - The content of the sitemap index XML file.
 * @return {string[]} An array of sitemap URLs.
 */
function getSitemapsFromSitemapIndex(sitemapIndexXml: string) {
  const $ = cheerio.load(sitemapIndexXml, { xml: true });
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
 * (up to `MAX_SITEMAP_DEPTH`, each sitemap is processed once).
 *
 * @param {string} sitemapUrl - The URL of the sitemap.
 * @return {string[]} An array of unique page URLs retrieved from the sitemap.
 */
export const getPagesFromSitemap = async (
  sitemapUrl: string,
  depth = 0,
  visited = new Set<string>(),
): Promise<string[]> => {
  if (visited.has(sitemapUrl)) {
    return [];
  }
  visited.add(sitemapUrl);

  // Only the fetch is limited (not the recursion), so nested sitemaps can't deadlock waiting for their parents
  const sitemapResponse = await fetchSitemap(sitemapUrl);
  // Fail loudly, silently skipping a sitemap would skip all of its pages
  if (!isSuccess(sitemapResponse.status)) {
    throw new Error(`Could not fetch sitemap ${sitemapUrl}: status ${sitemapResponse.status}`);
  }
  const response = sitemapResponse.data;
  const $ = cheerio.load(response, { xml: true });

  if ($("sitemapindex").length > 0) {
    if (depth >= MAX_SITEMAP_DEPTH) {
      console.warn(
        `Sitemap index ${sitemapUrl} is nested too deep (max depth ${MAX_SITEMAP_DEPTH}), skipping it.`,
      );
      return [];
    }
    const nestedSitemaps = getSitemapsFromSitemapIndex(response);
    console.log(`${sitemapUrl} is a sitemap index with ${nestedSitemaps.length} sitemaps`);
    const nestedPages = (
      await Promise.all(
        nestedSitemaps.map((nested) => getPagesFromSitemap(nested, depth + 1, visited)),
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
  return uniquePages;
};
