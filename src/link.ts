import { PromisePoolError } from "@supercharge/promise-pool";
import type { Page } from "playwright";
import { HASH_WAIT_TIMEOUT, PAGE_OPERATION_TIMEOUT, withPage } from "./browser";
import { checkLinkWithGithubApi } from "./github/gh_check_link";
import { isGithubCodeLineLink, isGithubUrl, isGithubWikiLink } from "./github/gh_url";
import { type AnchorIndex, buildAnchorIndex, getHashSelectors, isHashInAnchorIndex } from "./hash";
import { fetchWithHostLimit } from "./http";
import { withTimeout } from "./limiter";
import { withRun } from "./run";
import { incrementMetric, timePhase } from "./run_context";
import type { Link, LinkCheckResult, LinkWithResult } from "./types";
import {
  CONCURRENCY_LIMIT,
  FORBIDDEN_STATUS_CODES,
  getRandomUserAgent,
  log,
  OKAY_STATUS_CODES,
  PLAYWRIGHT_CONCURRENCY_LIMIT,
  parallelProcess,
  TASK_TIMEOUT,
} from "./utils";

export { closeBrowser } from "./browser";

type CheckLinksArgs = {
  links: Link[];
  verbose?: boolean;
  fetchConcurrencyLimit?: number;
};

/**
 * How a link is checked in the first pass:
 * - `github-api`: GitHub links checked with the GitHub API (definitive answers)
 * - `fetch`: plain `fetch`, assumes the page is server-side rendered
 * - `playwright`: needs a real browser (GitHub code line links), checked in the Playwright pass only
 * - `invalid`: the URL cannot be parsed or is not http(s), reported as broken link without any request
 */
export type CheckMethod = "fetch" | "github-api" | "playwright" | "invalid";

export const getInitialCheckMethod = (href: string): CheckMethod => {
  // Only http(s) links can be checked. Other schemes (`tel:`, `javascript:`, `data:`...) are filtered out
  // when links are extracted, anything that gets here anyway is reported without any request.
  if (!URL.canParse(href) || !["http:", "https:"].includes(new URL(href).protocol)) {
    return "invalid";
  }
  try {
    if (!isGithubUrl(href)) {
      return "fetch";
    }
    if (isGithubCodeLineLink(href)) {
      return "playwright";
    }
    if (isGithubWikiLink(href)) {
      return "fetch";
    }
    return "github-api";
  } catch {
    // Invalid URL, let fetch report it
    return "fetch";
  }
};

// Status codes returned by fetch that might be caused by bot protection, rate limiting or the request itself
export const PLAYWRIGHT_RETRY_STATUS_CODES = [401, 403, 405, 406, 408, 429];

/**
 * Decides if a failed first-pass result should be re-checked with Playwright.
 * Only failures that could be caused by the fetch method itself (client-side rendering, bot blocking,
 * rate limiting, network errors) are re-checked. Definitive answers (like 404 from the GitHub API) are not.
 */
export const shouldRecheckWithPlaywright = (
  result: LinkCheckResult,
  method: CheckMethod,
): boolean => {
  if (result.ok) {
    return false;
  }
  switch (method) {
    case "playwright":
      // Already checked with Playwright
      return false;
    case "invalid":
      // A URL that cannot be parsed is definitively broken
      return false;
    case "github-api":
      // "broken link" and "hash not found" from the API are definitive.
      // Unexpected errors (unknown link type, API errors) might still work in a browser.
      return result.error === "unexpected error";
    case "fetch":
      if (result.error === "broken link") {
        // No status means a network error or a timeout
        return (
          result.status === undefined ||
          PLAYWRIGHT_RETRY_STATUS_CODES.includes(result.status) ||
          result.status >= 500
        );
      }
      // "hash not found" (the page might be client-side rendered), "could not check", "unexpected error"
      return true;
  }
};

const checkLinkFirstPass = async (
  href: string,
  pageCache: PageFetchCache,
): Promise<{ result: LinkCheckResult; method: CheckMethod }> => {
  const method = getInitialCheckMethod(href);
  switch (method) {
    case "fetch":
    // `invalid` URLs are reported by checkLinkWithFetch without any request
    case "invalid":
      // Every request has its own timeout (FETCH_TIMEOUT)
      return { result: await checkLinkWithFetch(href, false, pageCache), method };
    case "playwright":
      // Not reached from checkLinks (code line links go straight to the Playwright pass), kept for completeness
      return { result: await checkLinkWithGithubApi(href), method };
    case "github-api":
      return {
        result: await withTimeout(
          checkLinkWithGithubApi(href),
          TASK_TIMEOUT,
          `GitHub API check timed out after ${TASK_TIMEOUT}ms`,
        ),
        method,
      };
  }
};

/**
 * Returns a function that calls `fn` at most once per key. Concurrent callers share the same promise.
 */
const memoizeByKey = <R>(fn: (key: string) => Promise<R>) => {
  const cache = new Map<string, Promise<R>>();
  return (key: string): Promise<R> => {
    let promise = cache.get(key);
    if (!promise) {
      promise = fn(key);
      cache.set(key, promise);
    }
    return promise;
  };
};

/** The URL without its hash (`https://example.com/page#section` -> `https://example.com/page`) */
export const stripHash = (href: string): string => {
  try {
    const url = new URL(href);
    url.hash = "";
    return url.href;
  } catch {
    return href;
  }
};

const hasHash = (href: string): boolean => {
  try {
    return new URL(href).hash !== "";
  } catch {
    return false;
  }
};

const getHostname = (href: string): string => {
  try {
    return new URL(href).hostname;
  } catch {
    return "";
  }
};

/**
 * Reorders items round-robin by host (`a1, b1, c1, a2, b2, a3...`), so a concurrency pool works on many hosts
 * at once instead of filling up with tasks waiting for the per-host limit of a single host.
 */
export const interleaveByHost = <T extends { href: string }>(items: T[]): T[] => {
  const byHost = new Map<string, T[]>();
  for (const item of items) {
    const host = getHostname(item.href);
    const hostItems = byHost.get(host);
    if (hostItems) {
      hostItems.push(item);
    } else {
      byHost.set(host, [item]);
    }
  }
  // Round-robin over the hosts that still have items: exhausted hosts are dropped, so every item is visited once
  // (O(items), not O(hosts x largest host))
  let queues = [...byHost.values()];
  const result: T[] = [];
  for (let i = 0; queues.length > 0; i++) {
    for (const queue of queues) {
      result.push(queue[i]);
    }
    queues = queues.filter((queue) => queue.length > i + 1);
  }
  return result;
};

/** Links grouped by the page they point to (URL without hash), in order of first appearance */
export const groupLinksByPage = (links: Link[]): Array<{ href: string; links: Link[] }> => {
  const groups = new Map<string, Link[]>();
  for (const link of links) {
    const pageUrl = stripHash(link.href);
    const group = groups.get(pageUrl);
    if (group) {
      group.push(link);
    } else {
      groups.set(pageUrl, [link]);
    }
  }
  return [...groups.entries()].map(([href, links]) => ({ href, links }));
};

/**
 * Checks links. Runs as a run (see `withRun`): the shared browser is closed and metrics are logged at the end.
 * - Every href is checked once, links to the same page with different hashes share one page fetch / navigation.
 * - First pass: `fetch` (limited per host) or the GitHub API.
 * - Failures that might be caused by the check method are re-checked with Playwright.
 */
export const checkLinks = (args: CheckLinksArgs) => withRun(() => checkLinksInRun(args));

const checkLinksInRun = async ({
  links,
  verbose,
  fetchConcurrencyLimit = CONCURRENCY_LIMIT,
}: CheckLinksArgs) => {
  console.log(`\nChecking ${links.length} links...`);
  const uniqueHrefs = new Set(links.map((link) => link.href));
  const uniquePages = new Set([...uniqueHrefs].map(stripHash));
  incrementMetric("totalLinks", links.length);
  incrementMetric("uniqueUrls", uniqueHrefs.size);
  incrementMetric("uniquePages", uniquePages.size);

  // Pages linked with a hash need their HTML (GET). Links to the same page without a hash reuse that response.
  const pagesWithHash = new Set(
    [...uniqueHrefs]
      .filter((href) => hasHash(href) && getInitialCheckMethod(href) === "fetch")
      .map(stripHash),
  );
  const pageCache = new PageFetchCache(pagesWithHash);

  const linksToCheckWithPlaywright: Link[] = [];
  // Cache the promise (not the result), so concurrent tasks with the same href share a single check
  const checkFirstPass = memoizeByKey((href) => checkLinkFirstPass(href, pageCache));

  const { results: fetchResults, errors: fetchErrors } = await timePhase(
    "Check links (fetch, GitHub API)",
    () =>
      parallelProcess({
        items: interleaveByHost(links),
        concurrencyLimit: fetchConcurrencyLimit,
        // Tasks can wait for a per-host slot, every check has its own timeout instead (see `checkLinkFirstPass`)
        taskTimeout: null,
        processFn: async (link): Promise<LinkWithResult | null> => {
          // Links that need a browser go straight to the Playwright pass, so they respect its concurrency limit
          // (and links to the same file with different line hashes share one navigation)
          if (getInitialCheckMethod(link.href) === "playwright") {
            linksToCheckWithPlaywright.push(link);
            return null;
          }
          const { result, method } = await checkFirstPass(link.href);
          // Failure possibly caused by the fetch method, add to Playwright queue
          if (shouldRecheckWithPlaywright(result, method)) {
            linksToCheckWithPlaywright.push(link);
            return null;
          }
          return { ...link, result };
        },
      }),
  );

  // One navigation per page, all hashes pointing to that page are checked in the same DOM
  const pageGroups = groupLinksByPage(linksToCheckWithPlaywright);
  console.log(
    `Checking ${linksToCheckWithPlaywright.length} links (${pageGroups.length} pages) with Playwright...`,
  );

  const { results: playwrightGroupResults, errors: playwrightGroupErrors } = await timePhase(
    "Re-check links with Playwright",
    () =>
      parallelProcess({
        items: pageGroups,
        concurrencyLimit: PLAYWRIGHT_CONCURRENCY_LIMIT,
        // No timeout for the whole group: it can include many per-hash fallback navigations waiting for page slots.
        // Every navigation and hash wait is bounded on its own (PAGE_OPERATION_TIMEOUT, HASH_WAIT_TIMEOUT).
        taskTimeout: null,
        processFn: async (group): Promise<LinkWithResult[]> => {
          const hrefs = [...new Set(group.links.map((link) => link.href))];
          const resultsByHref = await checkUrlsOnPageWithPlaywright(hrefs);
          return group.links.map((link) => ({
            ...link,
            result: resultFor(resultsByHref, link.href),
          }));
        },
      }),
  );
  const playwrightResults = playwrightGroupResults.flat();
  // Report errors per link, like in the first pass
  const playwrightErrors = playwrightGroupErrors.flatMap((error) =>
    error.item.links.map((link) => PromisePoolError.createFrom<Link>(error, link)),
  );

  const finalResults = [...fetchResults.filter((r) => r !== null), ...playwrightResults];
  const finalErrors = [...fetchErrors, ...playwrightErrors];

  console.log(
    `Checked ${finalResults.length} links (${uniqueHrefs.size} unique URLs, ${uniquePages.size} unique pages).`,
  );
  console.log(`Unexpected errors occurred for ${finalErrors.length} links`);
  log(finalErrors, verbose);
  return { results: finalResults, errors: finalErrors };
};

function shouldSpoofUserAgent(url: string) {
  // Android.com blocks you if you spoof the user agent
  if (url.includes("android.com")) {
    return false;
  }
  return true;
}

// When a HEAD request returns one of these, retry once with GET before failing
const HEAD_FALLBACK_STATUS_CODES = [403, 405, 501];

/**
 * Result of fetching a page (URL without hash): either a final failure, or the status and the anchors of the page.
 */
export type FetchedPage =
  | { ok: true; status: number; getAnchors?: () => AnchorIndex }
  | { ok: false; result: LinkCheckResult };

/** Parses the HTML on first use and then drops it, so cached pages only keep their (much smaller) anchor index */
const lazyAnchorIndex = (html: string) => {
  let source: string | undefined = html;
  let index: AnchorIndex | undefined;
  return () => {
    if (!index) {
      index = buildAnchorIndex(source ?? "");
      source = undefined;
    }
    return index;
  };
};

/**
 * Fetches a page with `GET` (if its HTML is needed) or `HEAD` (falls back to `GET` if the server refuses HEAD).
 * Limited per host, honours `Retry-After` on 429 (pauses the whole host). Never throws.
 */
export const fetchPage = async (
  url: string,
  { needBody, verbose = false }: { needBody: boolean; verbose?: boolean },
): Promise<FetchedPage> => {
  const headers = new Headers();
  if (shouldSpoofUserAgent(url)) {
    headers.set("User-Agent", getRandomUserAgent());
  }

  // Limited per host (every redirect hop too), a 429 with Retry-After pauses the host and is retried,
  // unread bodies are cancelled (see `fetchWithHostLimit`)
  const request = (method: "GET" | "HEAD") =>
    fetchWithHostLimit(url, { method, headers }, async (response) =>
      // Don't download the body when it's not needed (it might be a large file), it is cancelled instead.
      // An error page body is kept for the error detail (HEAD responses have none).
      method === "GET" && (needBody || !OKAY_STATUS_CODES.includes(response.status))
        ? response.text()
        : "",
    );

  try {
    let response = await request(needBody ? "GET" : "HEAD");
    // Some servers don't support (or block) HEAD requests, retry once with GET
    if (!needBody && HEAD_FALLBACK_STATUS_CODES.includes(response.status)) {
      log(`HEAD returned ${response.status}, retrying with GET`, verbose);
      response = await request("GET");
    }

    // Still rate limited after the retries (GitHub web rate limit makes you wait 60 seconds after 500 requests)
    const retryAfter = response.headers.get("Retry-After");
    if (response.status === 429 && retryAfter) {
      return {
        ok: false,
        result: {
          ok: false,
          error: "unexpected error",
          status: response.status,
          // Raw header without a unit: it can be seconds or an HTTP date
          errorDetail: `\n Rate limited and gave up, Retry-After: ${retryAfter} for link ${url}`,
        },
      };
    }

    if (OKAY_STATUS_CODES.includes(response.status) === false) {
      return {
        ok: false,
        result: {
          ok: false,
          error: "broken link",
          status: response.status,
          errorDetail: `${response.statusText} ${response.data}`,
        },
      };
    }

    return {
      ok: true,
      status: response.status,
      getAnchors: needBody ? lazyAnchorIndex(response.data) : undefined,
    };
  } catch (error) {
    log(`Something went wrong: ${error}`, verbose);
    return {
      ok: false,
      result: {
        ok: false,
        error: "broken link",
        errorDetail: String(error),
      },
    };
  }
};

/**
 * Page fetches of a single `checkLinks` call, keyed by URL without hash: each page is fetched once,
 * no matter how many links (with different hashes) point to it.
 */
export class PageFetchCache {
  private readonly pages = new Map<string, Promise<FetchedPage>>();

  /**
   * @param pagesWithHash pages (URLs without hash) that are linked with a hash somewhere. They are fetched with GET
   * right away, also for links without a hash, so the page is not fetched twice (HEAD and GET).
   */
  constructor(private readonly pagesWithHash: ReadonlySet<string> = new Set()) {}

  get(pageUrl: string, needBody: boolean, verbose = false): Promise<FetchedPage> {
    const getKey = `GET ${pageUrl}`;
    const useGet = needBody || this.pagesWithHash.has(pageUrl) || this.pages.has(getKey);
    const key = useGet ? getKey : `HEAD ${pageUrl}`;
    let page = this.pages.get(key);
    if (!page) {
      incrementMetric("uniquePagesFetched");
      page = fetchPage(pageUrl, { needBody: useGet, verbose });
      this.pages.set(key, page);
    }
    return page;
  }

  /** Number of distinct page fetches */
  get size() {
    return this.pages.size;
  }
}

/** Result for a URL (possibly with a hash) based on its fetched page */
const getResultFromPage = (page: FetchedPage, url: string): LinkCheckResult => {
  if (!page.ok) {
    return page.result;
  }
  const hash = new URL(url).hash;
  if (!hash) {
    return { ok: true, status: page.status };
  }

  if (hash === "#/") {
    return { ok: true, status: page.status, note: "Accidental hash" };
  }

  if (hash.includes(":~:")) {
    /**
     * The link includes a [Text Fragment](https://developer.mozilla.org/en-US/docs/Web/Text_fragments)
     * Checking this properly is not trivial, let's ignore them for now
     **/
    return { ok: true, status: page.status, note: "Text Fragment" };
  }

  // Note: GitHub `#L12` line links no longer work server-side, since GitHub switched to client-side rendering 🤦
  // Playwright fallback still works. The check is kept in case GitHub switches back to server-side rendering.
  if (!page.getAnchors || !isHashInAnchorIndex(page.getAnchors(), hash, url)) {
    return { ok: false, status: page.status, error: "hash not found" };
  }
  return { ok: true, status: page.status };
};

/**
 * Check a link with fetch, assuming page is server-side rendered
 * @param url link URL
 * @param verbose log details
 * @param pageCache share page fetches between links (links to the same page with different hashes fetch it once)
 * @returns LinkCheckResult, a URL that cannot be parsed is reported as a broken link
 */
export const checkLinkWithFetch = async (
  url: string,
  verbose = false,
  pageCache?: PageFetchCache,
): Promise<LinkCheckResult> => {
  // A URL that cannot be parsed (or is not http(s)) is a broken link, not an exception
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch (error) {
    return { ok: false, error: "broken link", errorDetail: `Invalid URL: ${String(error)}` };
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return {
      ok: false,
      error: "broken link",
      errorDetail: `Unsupported URL scheme: ${parsedUrl.protocol}`,
    };
  }
  const needBody = hasHash(url);
  const pageUrl = stripHash(url);
  const page = pageCache
    ? await pageCache.get(pageUrl, needBody, verbose)
    : await fetchPage(pageUrl, { needBody, verbose });
  const result = getResultFromPage(page, url);
  if (result.ok) {
    log(`OK`, verbose);
  }
  return result;
};

async function isHashPresentPlaywright(
  page: Page,
  hash: string,
  url: string,
  timeout = HASH_WAIT_TIMEOUT,
) {
  // All values are escaped, so any hash produces a valid selector
  const selectors = getHashSelectors(hash, url);
  const locator = page.locator(selectors.join(", ")).first();

  try {
    // Wait for the element to be in the DOM (client-side rendered pages add it later).
    // Anchors like `<a id="x"></a>` are valid targets but never "visible", so visibility is not required.
    await locator.waitFor({ state: "attached", timeout: timeout });
    return true;
  } catch (error) {
    // If the timeout is reached, return false instead of throwing an error
    if (error instanceof Error && error.name === "TimeoutError") {
      return false;
    }
    // Re-throw any other errors
    throw error;
  }
}

const getPlaywrightHashResult = async (
  page: Page,
  url: string,
  status: number,
  verbose: boolean,
): Promise<LinkCheckResult> => {
  const hash = new URL(url).hash.replace("#", "");
  if (!hash) {
    return { ok: true, status };
  }

  if (hash === "/") {
    return { ok: true, status, note: "Accidental hash" };
  }

  if (hash.includes(":~:")) {
    return { ok: true, status, note: "Text Fragment" };
  }

  if (!(await isHashPresentPlaywright(page, hash, url))) {
    log(`Hash not found`, verbose);
    return { ok: false, status, error: "hash not found" };
  }

  log(`OK`, verbose);
  return { ok: true, status };
};

/** Playwright checks return a result for every URL, the fallback only satisfies the type checker */
const resultFor = (results: Map<string, LinkCheckResult>, url: string): LinkCheckResult =>
  results.get(url) ?? { ok: false, error: "unexpected error", errorDetail: `No result for ${url}` };

/**
 * Checks URLs pointing to the same page (same URL without hash) with a single Playwright navigation:
 * navigates to the first URL, then checks the hash of every URL in the same DOM (in parallel).
 * Some pages render different content per hash (e.g. SPA tabs), so a hash not found in the shared DOM gets
 * a dedicated navigation to its exact URL before it is reported as "hash not found".
 * @returns results by URL
 */
export async function checkUrlsOnPageWithPlaywright(
  urls: string[],
  verbose = false,
  headless = true,
): Promise<Map<string, LinkCheckResult>> {
  const results = await checkUrlsInOneNavigation(urls, verbose, headless);
  const [firstUrl] = urls;
  const notFound = urls.filter((url) => {
    const result = results.get(url);
    return url !== firstUrl && result?.ok === false && result.error === "hash not found";
  });
  // After the shared navigation (its page slot is released), so the fallbacks can't deadlock waiting for slots
  await Promise.all(
    notFound.map(async (url) => {
      incrementMetric("playwrightHashFallbacks");
      const fallback = await checkUrlsInOneNavigation([url], verbose, headless);
      results.set(url, resultFor(fallback, url));
    }),
  );
  return results;
}

async function checkUrlsInOneNavigation(
  urls: string[],
  verbose: boolean,
  headless: boolean,
): Promise<Map<string, LinkCheckResult>> {
  const [firstUrl] = urls;
  const sameForAll = (result: LinkCheckResult) => new Map(urls.map((url) => [url, result]));

  // Browser launch or context errors are not the link's fault, they are thrown (reported as unexpected errors).
  // Errors while navigating and checking the page are reported as broken links.
  return withPage(
    async (page) => {
      try {
        incrementMetric("playwrightNavigations");
        // Heavy resources are blocked (see `withPage`), anchors rendered client-side are waited for below
        const response = await page.goto(firstUrl, {
          waitUntil: "domcontentloaded",
          timeout: PAGE_OPERATION_TIMEOUT,
        });

        log(`Navigation response: ${response?.status()}`, verbose);
        if (response && FORBIDDEN_STATUS_CODES.includes(response.status())) {
          return sameForAll({
            ok: false,
            error: "could not check",
            status: response.status(),
            errorDetail: `${response.statusText()} ${await response.text()}`,
          });
        }

        if (!response || !OKAY_STATUS_CODES.includes(response.status())) {
          return sameForAll({
            ok: false,
            error: "broken link",
            status: response?.status() ?? 0,
          });
        }

        const status = response.status();
        const results = await Promise.all(
          urls.map(
            async (url) =>
              [url, await getPlaywrightHashResult(page, url, status, verbose)] as const,
          ),
        );
        return new Map(results);
      } catch (error) {
        // The browser crashed: let `withPage` relaunch it and retry
        if (page.isClosed()) {
          throw error;
        }
        return sameForAll({
          ok: false,
          error: "broken link",
          errorDetail: String(error),
        });
      }
    },
    { userAgent: shouldSpoofUserAgent(firstUrl) ? getRandomUserAgent() : undefined, headless },
  );
}

/**
 * Checks a link with a real browser (the shared browser, see `withPage`).
 * Outside of a run (`checkLinks`, `checkWebsite`...), call `closeBrowser()` when done.
 */
export async function checkLinkWithPlaywright(
  url: string,
  verbose = false,
  headless = true,
): Promise<LinkCheckResult> {
  const results = await checkUrlsOnPageWithPlaywright([url], verbose, headless);
  return resultFor(results, url);
}
