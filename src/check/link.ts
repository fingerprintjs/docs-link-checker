/**
 * `checkLinks`: checks every unique link once, first with `fetch` or the GitHub API, then re-checks failures that
 * might be caused by the check method in a browser (see `shouldRecheckWithPlaywright`).
 */
import { checkLinkWithGithubApi } from "../github/check_link";
import { isGithubReservedRoute, isGithubUrl, isGithubWikiLink } from "../github/url";
import {
  getTerminal,
  incrementMetric,
  PLAYWRIGHT_CONCURRENCY_LIMIT,
  timePhase,
  withRun,
} from "../run";
import { plural } from "../terminal";
import type { Link, LinkCheckResult, LinkWithResult } from "../types";
import { getErrorMessage } from "../utils/errors";
import { CONCURRENCY_LIMIT, parallelProcess } from "../utils/parallel";
import { checkLinkWithFetch, PageFetchCache } from "./fetch_check";
import { hasHash, stripHash } from "./hash";
import { withTimeout } from "./limiter";
import { checkUrlsOnPageWithPlaywright } from "./playwright_check";
import { shouldRecheckWithPlaywright } from "./verdict";

// GitHub makes you wait 60s after hitting its rate limit, a check waiting that out still finishes in time
const GITHUB_API_CHECK_TIMEOUT = 80000;

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

/** The first-pass result, and if it is re-checked with Playwright (see `shouldRecheckWithPlaywright`) */
const checkLinkFirstPass = async (
  href: string,
  pageCache: PageFetchCache,
): Promise<{ result: LinkCheckResult; recheck: boolean }> => {
  const method = getInitialCheckMethod(href);
  switch (method) {
    case "invalid":
      // Definitively broken, nothing to re-check
      return {
        result: {
          ok: false,
          error: "broken link",
          errorDetail: `Unsupported or invalid URL: ${href}`,
        },
        recheck: false,
      };
    case "fetch": {
      // Every request has its own timeout (FETCH_TIMEOUT)
      const result = await checkLinkWithFetch(href, pageCache);
      return { result, recheck: shouldRecheckWithPlaywright("fetch", result) };
    }
    case "github-api": {
      const result = await withTimeout(
        (signal) => checkLinkWithGithubApi(href, signal),
        GITHUB_API_CHECK_TIMEOUT,
        `GitHub API check timed out after ${GITHUB_API_CHECK_TIMEOUT}ms`,
      );
      return { result, recheck: shouldRecheckWithPlaywright("github-api", result) };
    }
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
  const terminal = getTerminal();
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
  let failing = 0;

  const { errors: fetchErrors } = await timePhase("Check links (fetch, GitHub API)", () =>
    parallelProcess({
      items: interleaveByHost(uniqueHrefs.map((href) => ({ href }))),
      concurrencyLimit: fetchConcurrencyLimit,
      label: "Checking URLs",
      failing: () => failing,
      // Tasks can wait for a per-host slot, every check has its own timeout instead (see `checkLinkFirstPass`)
      processFn: async ({ href }) => {
        const { result, recheck } = await checkLinkFirstPass(href, pageCache);
        // Failure possibly caused by the check method, add to the Playwright queue instead of the final results
        if (recheck) {
          toRecheck.push(href);
        } else {
          results.set(href, result);
          if (!result.ok) failing++;
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

  terminal.done(`Checked ${plural(uniqueHrefs.length, "URL")}`, "fetch, GitHub API");

  // One navigation per page, all hashes pointing to that page are checked in the same DOM
  const pageGroups = groupHrefsByPage(toRecheck);

  const { errors: playwrightErrors } = await timePhase("Re-check links with Playwright", () =>
    parallelProcess({
      items: pageGroups,
      concurrencyLimit: PLAYWRIGHT_CONCURRENCY_LIMIT,
      label: "Re-checking pages in browser",
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

  if (pageGroups.length > 0) {
    terminal.done(`Re-checked ${plural(pageGroups.length, "page")} in browser`);
  }
  return links.map((link) => ({
    ...link,
    // Every unique href was given a result above (or an unexpected-error one for a throwing check)
    // oxlint-disable-next-line typescript/no-non-null-assertion -- see above
    result: results.get(link.href)!,
  }));
};
