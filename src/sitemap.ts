import * as cheerio from "cheerio";
import { getRandomUserAgent, log } from "./utils";
import { fetchWithHostLimit } from "./http";

// How deep nested sitemap indexes are followed (sitemap index -> sitemap index -> ... -> sitemap)
export const MAX_SITEMAP_DEPTH = 3;
// How many sitemaps are fetched at the same time (sitemap indexes can list thousands of sitemaps)
export const SITEMAP_FETCH_CONCURRENCY = 5;

/**
 * Limits how many calls of `fn` run at the same time. A finished call hands its slot directly to the next
 * queued call, so the limit is never exceeded.
 */
const createConcurrencyLimiter = (max: number) => {
  let active = 0;
  const queue: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active < max) {
      active++;
    } else {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    try {
      return await fn();
    } finally {
      const next = queue.shift();
      if (next) {
        next();
      } else {
        active--;
      }
    }
  };
};

const limitSitemapFetch = createConcurrencyLimiter(SITEMAP_FETCH_CONCURRENCY);

// Sitemaps can be large, give them more time than a regular page
const SITEMAP_FETCH_TIMEOUT = 60000;

const isSuccess = (status: number) => status >= 200 && status < 300;

/**
 * Fetches a sitemap: at most `SITEMAP_FETCH_CONCURRENCY` at the same time overall, and within the per-host limit
 * (`LINK_CHECK_HOST_CONCURRENCY`, with 429 Retry-After handling and redirects, see `fetchWithHostLimit`).
 * @returns the status and the body (empty if `readBody` is false or the response is not successful)
 */
const fetchSitemap = (sitemapUrl: string, readBody = true) =>
  limitSitemapFetch(() =>
    fetchWithHostLimit(
      sitemapUrl,
      { headers: { "User-Agent": getRandomUserAgent() }, timeoutMs: SITEMAP_FETCH_TIMEOUT },
      // Failed responses are not read, fetchWithHostLimit cancels their body
      async (response) => (readBody && response.ok ? response.text() : "")
    )
  );

/**
 * Retrieves all the pages from a website by fetching the sitemap and parsing it.
 *
 * @param {string} url - The URL of the website.
 * @param {boolean} [verbose=false] - Whether to log the progress of the function.
 * @return {Promise<string[]>} - A promise that resolves to an array of unique page URLs.
 */
export const getWebsitePages = async (url: string, verbose = false) => {
  const sitemaps = await getWebsiteSitemaps(url, verbose);
  // Shared between all sitemaps, so each sitemap is processed only once (per shallowest depth)
  const visitedSitemaps = new Map<string, number>();
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
  const sitemapExists = isSuccess((await fetchSitemap(`${url}/sitemap.xml`, false)).status);
  if (sitemapExists) {
    log("Sitemap.xml exists, parsing pages from it", verbose);
    return [`${url}/sitemap.xml`];
  }

  const sitemapIndex = (await fetchSitemap(`${url}/sitemap-index.xml`)).data;
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
 * (up to `MAX_SITEMAP_DEPTH`, each sitemap is processed once, or again if reached at a shallower depth).
 *
 * @param {string} sitemapUrl - The URL of the sitemap.
 * @param {boolean} [verbose=false] - Whether to log the progress.
 * @return {string[]} An array of unique page URLs retrieved from the sitemap.
 */
export const getPagesFromSitemap = async (
  sitemapUrl: string,
  verbose = false,
  depth = 0,
  // Sitemap URL -> shallowest depth it was processed at
  visitedSitemaps = new Map<string, number>()
): Promise<string[]> => {
  const visitedDepth = visitedSitemaps.get(sitemapUrl);
  // Only skip if it was already processed at the same or a shallower depth. A shallower visit can follow
  // nested indexes further, so it must not be skipped because of an earlier (concurrent) deeper visit.
  if (visitedDepth !== undefined && visitedDepth <= depth) {
    log(`Skipping already visited sitemap ${sitemapUrl}`, verbose);
    return [];
  }
  visitedSitemaps.set(sitemapUrl, depth);

  // Only the fetch is limited (not the recursion), so nested sitemaps can't deadlock waiting for their parents
  const sitemapResponse = await fetchSitemap(sitemapUrl);
  // Fail loudly, silently skipping a sitemap would skip all of its pages
  if (!isSuccess(sitemapResponse.status)) {
    throw new Error(`Could not fetch sitemap ${sitemapUrl}: status ${sitemapResponse.status}`);
  }
  const response = sitemapResponse.data;
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
