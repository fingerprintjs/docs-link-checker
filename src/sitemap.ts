import * as cheerio from "cheerio";
// TODO(effect): convert
import { fetchWithHostLimit } from "./effect_compat";
import { USER_AGENT } from "./http";

// How deep nested sitemap indexes are followed (sitemap index -> sitemap index -> ... -> sitemap)
export const MAX_SITEMAP_DEPTH = 3;

// Sitemaps can be large, give them more time than a regular page
const SITEMAP_FETCH_TIMEOUT = 60000;

const isSuccess = (status: number) => status >= 200 && status < 300;

// Concurrency is limited per host (see `fetchWithHostLimit`), which also covers nested sitemaps
const fetchSitemap = (sitemapUrl: string) =>
  fetchWithHostLimit(
    sitemapUrl,
    { headers: { "User-Agent": USER_AGENT }, timeoutMs: SITEMAP_FETCH_TIMEOUT },
    // Failed responses are not read, fetchWithHostLimit cancels their body
    async (response) => (response.ok ? response.text() : ""),
  );

/**
 * Retrieves all the pages from a website: `/sitemap.xml`, or `/sitemap-index.xml` if it does not exist.
 * Sitemap indexes are followed recursively.
 *
 * @return unique page URLs (empty if the website has no sitemap)
 */
export const getWebsitePages = async (url: string) => {
  for (const path of ["sitemap.xml", "sitemap-index.xml"]) {
    const sitemapUrl = `${url}/${path}`;
    const { status, data } = await fetchSitemap(sitemapUrl);
    if (isSuccess(status)) {
      console.log(`${path} exists, parsing pages from it`);
      return [...new Set(await parseSitemap(sitemapUrl, data, 0, new Set([sitemapUrl])))];
    }
  }
  console.error("No sitemap.xml or sitemap-index.xml found");
  return [];
};

/**
 * Extracts page URLs from a fetched sitemap. A sitemap index (`<sitemapindex>`) is followed recursively
 * (up to `MAX_SITEMAP_DEPTH`, each sitemap is processed once via `visited`).
 */
const parseSitemap = async (
  sitemapUrl: string,
  xml: string,
  depth: number,
  visited: Set<string>,
): Promise<string[]> => {
  const $ = cheerio.load(xml, { xml: true });

  if ($("sitemapindex").length > 0) {
    if (depth >= MAX_SITEMAP_DEPTH) {
      console.warn(
        `Sitemap index ${sitemapUrl} is nested too deep (max depth ${MAX_SITEMAP_DEPTH}), skipping it.`,
      );
      return [];
    }
    // A Set also drops duplicate entries within this index
    const nestedUrls = [...new Set(getLocations($, "sitemap"))].filter(
      (nested) => !visited.has(nested),
    );
    for (const nested of nestedUrls) visited.add(nested);
    console.log(`${sitemapUrl} is a sitemap index with ${nestedUrls.length} sitemaps`);
    const nestedPages = await Promise.all(
      nestedUrls.map(async (nested) => {
        const { status, data } = await fetchSitemap(nested);
        // Fail loudly, silently skipping a sitemap would skip all of its pages
        if (!isSuccess(status)) {
          throw new Error(`Could not fetch sitemap ${nested}: status ${status}`);
        }
        return parseSitemap(nested, data, depth + 1, visited);
      }),
    );
    return nestedPages.flat();
  }

  const pages = [...new Set(getLocations($, "url"))];
  console.log(`Retrieved ${pages.length} pages from ${sitemapUrl} sitemap.`);
  return pages;
};

const getLocations = ($: cheerio.CheerioAPI, tag: "url" | "sitemap") =>
  $(tag)
    .map((_, elem) => $(elem).find("loc").text().trim())
    .get()
    .filter(Boolean);
