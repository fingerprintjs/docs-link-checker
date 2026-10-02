import { PromisePoolError } from "@supercharge/promise-pool";
import { checkLinkWithFetch, PageFetchCache } from "./fetch_check";
import { checkLinkWithGithubApi } from "./github/gh_check_link";
import { isGithubReservedRoute, isGithubUrl, isGithubWikiLink } from "./github/gh_url";
import { withTimeout } from "./limiter";
import { hasHash, stripHash } from "./link_common";
import { checkUrlsOnPageWithPlaywright, resultFor } from "./playwright_check";
import { incrementMetric, timePhase, withRun } from "./run";
import type { Link, LinkCheckResult, LinkWithResult } from "./types";
import {
  CONCURRENCY_LIMIT,
  PLAYWRIGHT_CONCURRENCY_LIMIT,
  parallelProcess,
  TASK_TIMEOUT,
} from "./utils";

type CheckLinksArgs = {
  links: Link[];
  fetchConcurrencyLimit?: number;
};

/**
 * How a link is checked in the first pass:
 * - `github-api`: GitHub links checked with the GitHub API (definitive answers). Code line links (`#L12`) too: the
 *   file must have enough lines. github.com refuses blob pages to headless browsers on CI runners (503).
 * - `fetch`: plain `fetch`, assumes the page is server-side rendered
 * - `invalid`: the URL cannot be parsed or is not http(s), reported as broken link without any request
 */
export type CheckMethod = "fetch" | "github-api" | "invalid";

const getInitialCheckMethod = (href: string): CheckMethod => {
  // Only http(s) links can be checked. Other schemes (`tel:`, `javascript:`, `data:`...) are filtered out
  // when links are extracted, anything that gets here anyway is reported without any request.
  if (!URL.canParse(href) || !["http:", "https:"].includes(new URL(href).protocol)) {
    return "invalid";
  }
  try {
    if (!isGithubUrl(href)) {
      return "fetch";
    }
    // Wikis and GitHub's own pages (`/features`, `/topics/x`...) are not available through the API
    if (isGithubWikiLink(href) || isGithubReservedRoute(href)) {
      return "fetch";
    }
    return "github-api";
  } catch {
    // Invalid URL, let fetch report it
    return "fetch";
  }
};
// Status codes returned by fetch that might be caused by bot protection, rate limiting or the request itself
const PLAYWRIGHT_RETRY_STATUS_CODES = new Set([401, 403, 405, 406, 408, 429]);

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
  // Blocked by the destination policy (SSRF guard), the browser must not request it either
  if (result.destinationBlocked) {
    return false;
  }
  switch (method) {
    case "invalid":
      // A URL that cannot be parsed is definitively broken
      return false;
    case "github-api":
      // "broken link" and "hash not found" from the API are definitive.
      // Unexpected errors (unknown link type, API errors, rate limits, no `GH_TOKEN`) might still work in a browser.
      return result.error === "unexpected error";
    case "fetch":
      if (result.error === "broken link") {
        // No status means a network error or a timeout
        return (
          result.status === undefined ||
          PLAYWRIGHT_RETRY_STATUS_CODES.has(result.status) ||
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
      return { result: await checkLinkWithFetch(href, pageCache), method };
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
      // Queues shorter than i + 1 were dropped in the previous round
      const item = queue[i];
      if (item !== undefined) {
        result.push(item);
      }
    }
    queues = queues.filter((queue) => queue.length > i + 1);
  }
  return result;
};

/** Links grouped by the page they point to (URL without hash), in order of first appearance */
const groupLinksByPage = (links: Link[]): Array<{ href: string; links: Link[] }> => {
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
  return [...groups.entries()].map(([href, pageLinks]) => ({ href, links: pageLinks }));
};

/**
 * Checks links. Runs as a run (see `withRun`): the shared browser is closed and metrics are logged at the end.
 * - Every href is checked once, links to the same page with different hashes share one page fetch / navigation.
 * - First pass: `fetch` (limited per host) or the GitHub API.
 * - Failures that might be caused by the check method are re-checked with Playwright.
 */
export const checkLinks = (args: CheckLinksArgs) => withRun({}, () => checkLinksInRun(args));

const checkLinksInRun = async ({
  links,
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
        // Every navigation and hash wait is bounded on its own (PAGE_OPERATION_TIMEOUT, HASH_WAIT_TIMEOUT,
        // HASH_FALLBACK_WAIT_TIMEOUT).
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
  return { results: finalResults, errors: finalErrors };
};
