/**
 * Page URLs of a website from its sitemap(s).
 */
import * as cheerio from "cheerio";
import { Effect } from "effect";
import { type FetchError, HttpStatusError, type TooManyRedirects } from "./errors";
import { type Fetch, fetchLimited, USER_AGENT } from "./http";
import type { HostLimiter } from "./limiter";
import type { Metrics } from "./metrics";

// How deep nested sitemap indexes are followed (sitemap index -> sitemap index -> ... -> sitemap)
export const MAX_SITEMAP_DEPTH = 3;

// Sitemaps can be large, give them more time than a regular page
const SITEMAP_FETCH_TIMEOUT = 60000;

const isSuccess = (status: number) => status >= 200 && status < 300;

// Concurrency is limited per host (see `fetchLimited`), which also covers nested sitemaps
const fetchSitemap = (sitemapUrl: string) =>
  fetchLimited(
    sitemapUrl,
    { headers: { "User-Agent": USER_AGENT }, timeoutMs: SITEMAP_FETCH_TIMEOUT },
    // Failed responses are not read, `fetchLimited` cancels their body
    (response) => (response.ok ? response.text() : Promise.resolve("")),
  );

const getLocations = ($: cheerio.CheerioAPI, tag: "url" | "sitemap") =>
  $(tag)
    .map((_, elem) => $(elem).find("loc").text().trim())
    .get()
    .filter(Boolean);

/**
 * Extracts page URLs from a fetched sitemap. A sitemap index (`<sitemapindex>`) is followed recursively
 * (up to `MAX_SITEMAP_DEPTH`, each sitemap is processed once via `visited`).
 */
const parseSitemap = (
  sitemapUrl: string,
  xml: string,
  depth: number,
  visited: Set<string>,
): Effect.Effect<
  string[],
  FetchError | TooManyRedirects | HttpStatusError,
  Fetch | HostLimiter | Metrics
> =>
  Effect.gen(function* () {
    const $ = cheerio.load(xml, { xml: true });

    if ($("sitemapindex").length > 0) {
      if (depth >= MAX_SITEMAP_DEPTH) {
        yield* Effect.logWarning(
          `Sitemap index ${sitemapUrl} is nested too deep (max depth ${MAX_SITEMAP_DEPTH}), skipping it.`,
        );
        return [];
      }
      // A Set also drops duplicate entries within this index
      const nestedUrls = [...new Set(getLocations($, "sitemap"))].filter(
        (nested) => !visited.has(nested),
      );
      for (const nested of nestedUrls) visited.add(nested);
      yield* Effect.logInfo(`${sitemapUrl} is a sitemap index with ${nestedUrls.length} sitemaps`);
      const nestedPages = yield* Effect.forEach(
        nestedUrls,
        (nested) =>
          Effect.gen(function* () {
            const { status, data } = yield* fetchSitemap(nested);
            // Fail loudly, silently skipping a sitemap would skip all of its pages
            if (!isSuccess(status)) {
              return yield* new HttpStatusError({
                url: nested,
                status,
                message: `Could not fetch sitemap ${nested}: status ${status}`,
              });
            }
            return yield* parseSitemap(nested, data, depth + 1, visited);
          }),
        { concurrency: "unbounded" },
      );
      return nestedPages.flat();
    }

    const pages = [...new Set(getLocations($, "url"))];
    yield* Effect.logInfo(`Retrieved ${pages.length} pages from ${sitemapUrl} sitemap.`);
    return pages;
  });

/**
 * Retrieves all the pages from a website: `/sitemap.xml`, or `/sitemap-index.xml` if it does not exist.
 * Sitemap indexes are followed recursively.
 *
 * @return unique page URLs (empty if the website has no sitemap)
 */
export const getWebsitePages = Effect.fn("sitemap.getWebsitePages")(function* (url: string) {
  for (const path of ["sitemap.xml", "sitemap-index.xml"]) {
    const sitemapUrl = `${url}/${path}`;
    const { status, data } = yield* fetchSitemap(sitemapUrl);
    if (isSuccess(status)) {
      yield* Effect.logInfo(`${path} exists, parsing pages from it`);
      const pages = yield* parseSitemap(sitemapUrl, data, 0, new Set([sitemapUrl]));
      return [...new Set(pages)];
    }
  }
  yield* Effect.logError("No sitemap.xml or sitemap-index.xml found");
  return [];
});
