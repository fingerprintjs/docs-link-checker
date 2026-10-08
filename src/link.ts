/**
 * Link checks: first pass (fetch / GitHub API), Playwright re-check of failures that the check method may cause.
 */
import { Effect } from "effect";
import type { RunServices } from "./app";
import { PLAYWRIGHT_CONCURRENCY_LIMIT } from "./browser";
import { getErrorMessage } from "./errors";
import { checkLinkWithFetch, makePageCache, type PageCache } from "./fetch_check";
import { checkLinkWithGithubApi } from "./github/gh_check_link";
import { isGithubReservedRoute, isGithubUrl, isGithubWikiLink } from "./github/gh_url";
import { hasHash, stripHash } from "./hash";
import { Metrics } from "./metrics";
import { checkUrlsOnPageWithPlaywright } from "./playwright_check";
import type { Link, LinkCheckResult, LinkWithResult } from "./types";
import { CONCURRENCY_LIMIT, processAll } from "./utils";

/**
 * How a link is checked in the first pass:
 * - `github-api`: GitHub links checked with the GitHub API (definitive answers). Code line links (`#L12`) too: the
 *   file must have enough lines. github.com refuses blob pages to headless browsers on CI runners (503).
 * - `fetch`: plain `fetch`, assumes the page is server-side rendered
 * - `invalid`: the URL cannot be parsed or is not http(s), reported as broken link without any request
 */
type CheckMethod = "fetch" | "github-api" | "invalid";

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
const shouldRecheckWithPlaywright = (result: LinkCheckResult, method: CheckMethod): boolean => {
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

const checkLinkFirstPass = (
  href: string,
  method: CheckMethod,
  pageCache: PageCache,
): Effect.Effect<LinkCheckResult, unknown, RunServices> => {
  switch (method) {
    case "invalid":
      return Effect.succeed({
        ok: false,
        error: "broken link",
        errorDetail: `Unsupported or invalid URL: ${href}`,
      });
    case "fetch":
      return checkLinkWithFetch(href, pageCache);
    case "github-api":
      // The GitHub client times out each of its requests, see `GitHubTimeout`
      return checkLinkWithGithubApi(href);
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
export const interleaveByHost = <T extends { href: string }>(items: ReadonlyArray<T>): T[] => {
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
const groupHrefsByPage = (hrefs: ReadonlyArray<string>): string[][] => {
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

const unexpectedError = (error: unknown): LinkCheckResult => ({
  ok: false,
  error: "unexpected error",
  errorDetail: getErrorMessage(error),
});

/**
 * Checks links:
 * - Every unique href is checked once, links to the same page with different hashes share one page fetch / navigation.
 * - First pass: `fetch` (limited per host) or the GitHub API.
 * - Failures that might be caused by the check method are re-checked with Playwright.
 * - A check that fails is reported as an "unexpected error" result, like any other failure.
 */
export const checkLinks = Effect.fn("link.checkLinks")(function* ({
  links,
  fetchConcurrencyLimit = CONCURRENCY_LIMIT,
}: {
  readonly links: ReadonlyArray<Link>;
  /** Default `CONCURRENCY_LIMIT` */
  readonly fetchConcurrencyLimit?: number;
}) {
  const metrics = yield* Metrics;
  yield* Effect.logInfo(`\nChecking ${links.length} links...`);
  const uniqueHrefs = [...new Set(links.map((link) => link.href))];
  const uniquePages = new Set(uniqueHrefs.map(stripHash));
  yield* metrics.increment("totalLinks", links.length);
  yield* metrics.increment("uniqueUrls", uniqueHrefs.length);
  yield* metrics.increment("uniquePages", uniquePages.size);

  const methods = new Map(uniqueHrefs.map((href) => [href, getInitialCheckMethod(href)]));
  // Pages linked with a hash need their HTML (GET). Links to the same page without a hash reuse that response.
  const pagesWithHash = new Set(
    uniqueHrefs.filter((href) => hasHash(href) && methods.get(href) === "fetch").map(stripHash),
  );
  const pageCache = yield* makePageCache(pagesWithHash);

  // One entry per unique href, filled by the two passes below
  const results = new Map<string, LinkCheckResult>();
  const toRecheck: string[] = [];

  const firstPass = yield* metrics.timePhase(
    "Check links (fetch, GitHub API)",
    processAll({
      items: interleaveByHost(uniqueHrefs.map((href) => ({ href }))),
      concurrency: fetchConcurrencyLimit,
      // Tasks can wait for a per-host slot, every request has its own timeout instead
      process: ({ href }) => {
        const method = methods.get(href) ?? "invalid";
        return checkLinkFirstPass(href, method, pageCache).pipe(
          Effect.map((result) => ({ href, result, method })),
        );
      },
    }),
  );
  for (const { href, result, method } of firstPass.results) {
    // Failure possibly caused by the fetch method, add to the Playwright queue instead of the final results
    if (shouldRecheckWithPlaywright(result, method)) {
      toRecheck.push(href);
    } else {
      results.set(href, result);
    }
  }
  for (const { item, error } of firstPass.errors) {
    results.set(item.href, unexpectedError(error));
  }

  // One navigation per page, all hashes pointing to that page are checked in the same DOM
  const pageGroups = groupHrefsByPage(toRecheck);
  yield* Effect.logInfo(
    `Checking ${toRecheck.length} links (${pageGroups.length} pages) with Playwright...`,
  );

  const recheck = yield* metrics.timePhase(
    "Re-check links with Playwright",
    processAll({
      items: pageGroups,
      concurrency: PLAYWRIGHT_CONCURRENCY_LIMIT,
      // No timeout for the whole group: it can wait for a page slot and for the host to resume.
      // Every navigation and hash wait is bounded on its own (see `playwright_check.ts`).
      process: checkUrlsOnPageWithPlaywright,
    }),
  );
  for (const resultsByHref of recheck.results) {
    // A result for every URL of the page
    for (const [href, result] of resultsByHref) {
      results.set(href, result);
    }
  }
  for (const { item: hrefs, error } of recheck.errors) {
    for (const href of hrefs) {
      results.set(href, unexpectedError(error));
    }
  }

  yield* Effect.logInfo(
    `Checked ${uniqueHrefs.length} unique URLs (${uniquePages.size} unique pages).`,
  );
  return links.map((link): LinkWithResult => ({
    ...link,
    // Every unique href got a result above
    result: results.get(link.href) ?? unexpectedError("no result"),
  }));
});
