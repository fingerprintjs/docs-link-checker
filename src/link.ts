import { PLAYWRIGHT_CONCURRENCY_LIMIT } from "./browser";
import { checkLinkWithFetch, PageFetchCache } from "./fetch_check";
import { checkLinkWithGithubApi } from "./github/gh_check_link";
import { isGithubReservedRoute, isGithubUrl, isGithubWikiLink } from "./github/gh_url";
import { hasHash, stripHash } from "./hash";
import { TASK_TIMEOUT } from "./http";
import { withTimeout } from "./limiter";
import { checkUrlsOnPageWithPlaywright } from "./playwright_check";
import { incrementMetric, timePhase, withRun } from "./run";
import type { Link, LinkCheckResult, LinkWithResult } from "./types";
import { CONCURRENCY_LIMIT, parallelProcess } from "./utils";
import { getErrorMessage } from "./utils/errors";

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
  let protocol: string;
  try {
    protocol = new URL(href).protocol;
  } catch {
    return "invalid";
  }
  if (protocol !== "http:" && protocol !== "https:") {
    return "invalid";
  }
  if (!isGithubUrl(href)) {
    return "fetch";
  }
  // Wikis and GitHub's own pages (`/features`, `/topics/x`...) are not available through the API
  if (isGithubWikiLink(href) || isGithubReservedRoute(href)) {
    return "fetch";
  }
  return "github-api";
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
    case "invalid":
      return {
        result: {
          ok: false,
          error: "broken link",
          errorDetail: `Unsupported or invalid URL: ${href}`,
        },
        method,
      };
    case "fetch":
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

/** Hrefs grouped by the page they point to (URL without hash), in order of first appearance */
const groupHrefsByPage = (hrefs: string[]): string[][] => {
  const groups = new Map<string, string[]>();
  for (const href of hrefs) {
    const pageUrl = stripHash(href);
    const group = groups.get(pageUrl);
    if (group) {
      group.push(href);
    } else {
      groups.set(pageUrl, [href]);
    }
  }
  return [...groups.values()];
};

/**
 * Checks links. Runs as a run (see `withRun`): the shared browser is closed and metrics are logged at the end.
 * - Every unique href is checked once, links to the same page with different hashes share one page fetch / navigation.
 * - First pass: `fetch` (limited per host) or the GitHub API.
 * - Failures that might be caused by the check method are re-checked with Playwright.
 * - A check that throws is reported as an "unexpected error" result, like any other failure.
 */
export const checkLinks = (args: CheckLinksArgs): Promise<LinkWithResult[]> =>
  withRun({}, () => checkLinksInRun(args));

const checkLinksInRun = async ({
  links,
  fetchConcurrencyLimit = CONCURRENCY_LIMIT,
}: CheckLinksArgs): Promise<LinkWithResult[]> => {
  console.log(`\nChecking ${links.length} links...`);
  const uniqueHrefs = [...new Set(links.map((link) => link.href))];
  const uniquePages = new Set(uniqueHrefs.map(stripHash));
  incrementMetric("totalLinks", links.length);
  incrementMetric("uniqueUrls", uniqueHrefs.length);
  incrementMetric("uniquePages", uniquePages.size);

  // Pages linked with a hash need their HTML (GET). Links to the same page without a hash reuse that response.
  const pagesWithHash = new Set(
    uniqueHrefs
      .filter((href) => hasHash(href) && getInitialCheckMethod(href) === "fetch")
      .map(stripHash),
  );
  const pageCache = new PageFetchCache(pagesWithHash);

  // Filled in by the two passes below, one entry per unique href
  const results = new Map<string, LinkCheckResult>();
  const toRecheck: string[] = [];

  const { errors: fetchErrors } = await timePhase("Check links (fetch, GitHub API)", () =>
    parallelProcess({
      items: interleaveByHost(uniqueHrefs.map((href) => ({ href }))),
      concurrencyLimit: fetchConcurrencyLimit,
      // Tasks can wait for a per-host slot, every check has its own timeout instead (see `checkLinkFirstPass`)
      processFn: async ({ href }) => {
        const { result, method } = await checkLinkFirstPass(href, pageCache);
        // Failure possibly caused by the fetch method, add to the Playwright queue instead of the final results
        if (shouldRecheckWithPlaywright(result, method)) {
          toRecheck.push(href);
        } else {
          results.set(href, result);
        }
      },
    }),
  );
  for (const { item, error } of fetchErrors) {
    results.set(item.href, {
      ok: false,
      error: "unexpected error",
      errorDetail: getErrorMessage(error),
    });
  }

  // One navigation per page, all hashes pointing to that page are checked in the same DOM
  const pageGroups = groupHrefsByPage(toRecheck);
  console.log(`Checking ${toRecheck.length} links (${pageGroups.length} pages) with Playwright...`);

  const { errors: playwrightErrors } = await timePhase("Re-check links with Playwright", () =>
    parallelProcess({
      items: pageGroups,
      concurrencyLimit: PLAYWRIGHT_CONCURRENCY_LIMIT,
      // No timeout for the whole group: it can wait for a page slot and for the host to resume.
      // Every navigation and hash wait is bounded on its own (PAGE_OPERATION_TIMEOUT, HASH_WAIT_TIMEOUT,
      // HASH_FALLBACK_WAIT_TIMEOUT).
      processFn: async (hrefs) => {
        const resultsByHref = await checkUrlsOnPageWithPlaywright(hrefs);
        // A result for every URL of the page
        for (const [href, result] of resultsByHref) {
          results.set(href, result);
        }
      },
    }),
  );
  for (const { item: hrefs, error } of playwrightErrors) {
    const errorDetail = getErrorMessage(error);
    for (const href of hrefs) {
      results.set(href, { ok: false, error: "unexpected error", errorDetail });
    }
  }

  console.log(`Checked ${uniqueHrefs.length} unique URLs (${uniquePages.size} unique pages).`);
  return links.map((link) => ({
    ...link,
    // Every unique href was given a result above (or an unexpected-error one for a throwing check)
    // oxlint-disable-next-line typescript/no-non-null-assertion -- see above
    result: results.get(link.href)!,
  }));
};
