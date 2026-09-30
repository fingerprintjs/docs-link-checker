import { chromium, Page } from "playwright";
import {
  CONCURRENCY_LIMIT,
  FETCH_TIMEOUT,
  FORBIDDEN_STATUS_CODES,
  OKAY_STATUS_CODES,
  PLAYWRIGHT_CONCURRENCY_LIMIT,
  TASK_TIMEOUT,
  getRandomUserAgent,
  log,
  parallelProcess,
} from "./utils";
import { Link, LinkCheckResult, LinkWithResult } from "./types";
import { checkLinkWithGithubApi } from "./github/gh_check_link";
import { isGithubCodeLineLink, isGithubUrl, isGithubWikiLink } from "./github/gh_url";
import { getHashSelectors, isHashPresentInHtml } from "./hash";

type CheckLinksArgs = {
  links: Link[];
  verbose?: boolean;
  fetchConcurrencyLimit?: number;
};

/**
 * How a link is checked in the first pass:
 * - `github-api`: GitHub links checked with the GitHub API (definitive answers)
 * - `fetch`: plain `fetch`, assumes the page is server-side rendered
 * - `playwright`: already checked with a real browser (GitHub code line links)
 */
export type CheckMethod = "fetch" | "github-api" | "playwright";

export const getInitialCheckMethod = (href: string): CheckMethod => {
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
export const shouldRecheckWithPlaywright = (result: LinkCheckResult, method: CheckMethod): boolean => {
  if (result.ok) {
    return false;
  }
  switch (method) {
    case "playwright":
      // Already checked with Playwright
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
  href: string
): Promise<{ result: LinkCheckResult; method: CheckMethod }> => {
  const method = getInitialCheckMethod(href);
  const result = method === "fetch" ? await checkLinkWithFetch(href) : await checkLinkWithGithubApi(href);
  return { result, method };
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

export const checkLinks = async ({ links, verbose, fetchConcurrencyLimit = CONCURRENCY_LIMIT }: CheckLinksArgs) => {
  console.log(`\nChecking ${links.length} links...`);

  const linksToCheckWithPlaywright: Link[] = [];
  // Cache the promise (not the result), so concurrent tasks with the same href share a single check
  const checkFirstPass = memoizeByKey(checkLinkFirstPass);

  const { results: fetchResults, errors: fetchErrors } = await parallelProcess({
    items: links,
    concurrencyLimit: fetchConcurrencyLimit,
    processFn: async (link): Promise<LinkWithResult | null> => {
      const { result, method } = await checkFirstPass(link.href);
      // Failure possibly caused by the fetch method, add to Playwright queue
      if (shouldRecheckWithPlaywright(result, method)) {
        linksToCheckWithPlaywright.push(link);
        return null;
      }
      return { ...link, result };
    },
  });

  console.log(`Checking ${linksToCheckWithPlaywright.length} links with Playwright...`);

  const checkWithPlaywright = memoizeByKey((href) => checkLinkWithPlaywright(href));
  const { results: playwrightResults, errors: playwrightErrors } = await parallelProcess({
    items: linksToCheckWithPlaywright,
    concurrencyLimit: PLAYWRIGHT_CONCURRENCY_LIMIT,
    processFn: async (link): Promise<LinkWithResult> => {
      const result = await checkWithPlaywright(link.href);
      return { ...link, result };
    },
  });

  const finalResults = [...fetchResults.filter((r) => r !== null), ...playwrightResults];
  const finalErrors = [...fetchErrors, ...playwrightErrors];

  console.log(`Checked ${finalResults.length} links.`);
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
 * Check a link with fetch, assuming page is server-side rendered
 * @param url link URL
 * @returns LinkCheckResult
 * @throws {Error} - if the URL cannot be parsed
 */
export const checkLinkWithFetch = async (url: string, verbose = false): Promise<LinkCheckResult> => {
  const hash = new URL(url).hash;

  const headers = new Headers();
  if (shouldSpoofUserAgent(url)) {
    headers.set("User-Agent", getRandomUserAgent());
  }

  const request = (method: "GET" | "HEAD") =>
    fetch(url, {
      method,
      redirect: "follow",
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });

  try {
    let response = await request(hash ? "GET" : "HEAD");
    // Some servers don't support (or block) HEAD requests, retry once with GET
    if (!hash && HEAD_FALLBACK_STATUS_CODES.includes(response.status)) {
      log(`HEAD returned ${response.status}, retrying with GET`, verbose);
      response = await request("GET");
    }

    // GitHub web rate limit makes you wait 60 seconds after 500 requests
    const retryAfter = response.headers.get("Retry-After");
    if (response.status === 429 && retryAfter) {
      const retryAfterSeconds = parseInt(retryAfter);
      const retryAfterMs = retryAfterSeconds * 1000;
      if (retryAfterMs < TASK_TIMEOUT) {
        console.log(`Rate limited, retrying after ${retryAfter} seconds...`);
        await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
        return await checkLinkWithFetch(url, verbose);
      } else {
        return {
          ok: false,
          error: "unexpected error",
          status: response.status,
          errorDetail: `\n Rate limited and gave up, retry-after: ${retryAfterSeconds} seconds for link ${url}`,
        };
      }
    }

    if (OKAY_STATUS_CODES.includes(response.status) === false) {
      return {
        ok: false,
        error: "broken link",
        status: response.status,
        errorDetail: `${response.statusText} ${await response.text()}`,
      };
    }

    if (!hash) {
      log(`OK`, verbose);
      return { ok: true, status: response.status };
    }

    if (hash === "#/") {
      return { ok: true, status: response.status, note: "Accidental hash" };
    }

    if (hash.includes(":~:")) {
      /**
       * The link includes a [Text Fragment](https://developer.mozilla.org/en-US/docs/Web/Text_fragments)
       * Checking this properly is not trivial, let's ignore them for now
       **/
      return { ok: true, status: response.status, note: "Text Fragment" };
    }

    // Note: GitHub `#L12` line links no longer work server-side, since GitHub switched to client-side rendering 🤦
    // Playwright fallback still works. The check is kept in case GitHub switches back to server-side rendering.
    if (!isHashPresentInHtml(await response.text(), hash, url)) {
      return {
        ok: false,
        status: response.status,
        error: "hash not found",
      };
    }

    log(`OK`, verbose);
    return { ok: true, status: response.status };
  } catch (error) {
    log(`Something went wrong: ${error}`, verbose);
    return {
      ok: false,
      error: "broken link",
      errorDetail: String(error),
    };
  }
};

async function isHashPresentPlaywright(page: Page, hash: string, url: string, timeout = 3000) {
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

export async function checkLinkWithPlaywright(url: string, verbose = false, headless = true): Promise<LinkCheckResult> {
  const browser = await chromium.launch({
    headless,
    // Potentially helps avoid some bot detection checks
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    userAgent: shouldSpoofUserAgent(url) ? getRandomUserAgent() : undefined,
  });
  const page = await context.newPage();

  try {
    // Navigate to the URL
    const response = await page.goto(url);

    log(`Navigation response: ${response?.status()}`, verbose);
    if (response && FORBIDDEN_STATUS_CODES.includes(response.status())) {
      return {
        ok: false,
        error: "could not check",
        status: response.status(),
        errorDetail: `${response.statusText()} ${await response.text()}`,
      };
    }

    // Check if the current URL matches the given URL
    if (!response || !OKAY_STATUS_CODES.includes(response.status())) {
      return {
        ok: false,
        error: "broken link",
        status: response?.status() ?? 0,
      };
    }

    const hash = new URL(url).hash.replace("#", "");

    if (hash === "/") {
      return { ok: true, status: response.status(), note: "Accidental hash" };
    }

    if (hash.includes(":~:")) {
      return { ok: true, status: response.status(), note: "Text Fragment" };
    }

    if (hash && !(await isHashPresentPlaywright(page, hash, url))) {
      log(`Hash not found`, verbose);
      return {
        ok: false,
        status: response.status(),
        error: "hash not found",
      };
    }

    log(`OK`, verbose);
    return { ok: true, status: response.status() };
  } catch (error) {
    return {
      ok: false,
      error: "broken link",
      errorDetail: String(error),
    };
  } finally {
    if (headless) {
      await browser.close();
    }
  }
}
