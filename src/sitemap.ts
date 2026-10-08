import * as cheerio from "cheerio";
import { Data, Effect } from "effect";
import { fetchWithHostLimit, readText, USER_AGENT } from "./http";
import type { HostLimiter } from "./limiter";
import type { Metrics } from "./run";
import type { FetchError, TimeoutError, TooManyRedirects } from "./utils/errors";

// How deep nested sitemap indexes are followed (sitemap index -> sitemap index -> ... -> sitemap)
export const MAX_SITEMAP_DEPTH = 3;

// Sitemaps can be large, give them more time than a regular page
const SITEMAP_FETCH_TIMEOUT = 60000;

const isSuccess = (status: number) => status >= 200 && status < 300;

/** A sitemap answered with a status other than 2xx where one is required (nested sitemaps) */
export class SitemapStatusError extends Data.TaggedError("SitemapStatusError")<{
  readonly url: string;
  readonly status: number;
}> {
  override get message() {
    return `Could not fetch sitemap ${this.url}: status ${this.status}`;
  }
}

// Concurrency is limited per host (see `fetchWithHostLimit`), which also covers nested sitemaps
const fetchSitemap = (sitemapUrl: string) =>
  fetchWithHostLimit(
    sitemapUrl,
    { headers: { "User-Agent": USER_AGENT }, timeoutMs: SITEMAP_FETCH_TIMEOUT },
    // Failed responses are not read, fetchWithHostLimit cancels their body
    (response) => (response.ok ? readText(response) : Effect.succeed("")),
  );

/**
 * Retrieves all the pages from a website: `/sitemap.xml`, or `/sitemap-index.xml` if it does not exist.
 * Sitemap indexes are followed recursively.
 *
 * @return unique page URLs (empty if the website has no sitemap). Fails if a request fails or a nested sitemap
 * answers with an error status.
 */
export const getWebsitePages = (url: string) =>
  Effect.gen(function* () {
    for (const path of ["sitemap.xml", "sitemap-index.xml"]) {
      const sitemapUrl = `${url}/${path}`;
      const { status, data } = yield* fetchSitemap(sitemapUrl);
      if (isSuccess(status)) {
        console.log(`${path} exists, parsing pages from it`);
        const pages = yield* parseSitemap(sitemapUrl, data, 0, new Set([sitemapUrl]));
        return [...new Set(pages)];
      }
    }
    console.error("No sitemap.xml or sitemap-index.xml found");
    return [];
  });

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
  SitemapStatusError | FetchError | TimeoutError | TooManyRedirects,
  HostLimiter | Metrics
> =>
  Effect.gen(function* () {
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
      const nestedPages = yield* Effect.forEach(
        nestedUrls,
        (nested) =>
          Effect.gen(function* () {
            const { status, data } = yield* fetchSitemap(nested);
            // Fail loudly, silently skipping a sitemap would skip all of its pages
            if (!isSuccess(status)) {
              return yield* new SitemapStatusError({ url: nested, status });
            }
            return yield* parseSitemap(nested, data, depth + 1, visited);
          }),
        { concurrency: "unbounded" },
      );
      return nestedPages.flat();
    }

    const pages = [...new Set(getLocations($, "url"))];
    console.log(`Retrieved ${pages.length} pages from ${sitemapUrl} sitemap.`);
    return pages;
  });

const getLocations = ($: cheerio.CheerioAPI, tag: "url" | "sitemap") =>
  $(tag)
    .map((_, elem) => $(elem).find("loc").text().trim())
    .get()
    .filter(Boolean);
