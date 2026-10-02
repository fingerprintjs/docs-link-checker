import type { Page, Response as PlaywrightResponse } from "playwright";
import {
  HASH_FALLBACK_WAIT_TIMEOUT,
  HASH_WAIT_TIMEOUT,
  PAGE_OPERATION_TIMEOUT,
  withPage,
} from "./browser";
import { assertDestinationAllowed, DestinationNotAllowedError } from "./destination";
import { isGithubCodeLineLink } from "./github/gh_url";
import { getHashSelectors } from "./hash";
import {
  FORBIDDEN_STATUS_CODES,
  formatServerErrorRetry,
  getRandomUserAgent,
  getServerErrorRetryDelay,
  OKAY_STATUS_CODES,
  TRANSIENT_SERVER_ERROR_STATUS_CODES,
} from "./http";
import { withTimeout } from "./limiter";
import {
  getBlockedDestinationResult,
  getServerErrorResult,
  getSpecialFragmentNote,
  shouldSpoofUserAgent,
} from "./link_common";
import { getHostLimiter, incrementMetric } from "./run";
import type { LinkCheckResult } from "./types";

/** Waits up to `timeout` for an element matching `selector` to be in the DOM */
async function waitForSelectorAttached(page: Page, selector: string, timeout: number) {
  try {
    // Wait for the element to be in the DOM (client-side rendered pages add it later).
    // Anchors like `<a id="x"></a>` are valid targets but never "visible", so visibility is not required.
    await page.locator(selector).first().waitFor({ state: "attached", timeout });
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

// Line numbers of the GitHub code view (`<div data-line-number="12">`)
const GITHUB_CODE_LINE_SELECTOR = "[data-line-number]";

/**
 * Body of a navigation response, `""` if it can't be read within `PAGE_OPERATION_TIMEOUT` (Playwright has no timeout
 * for response bodies, a body that never ends would hold the page slot). The page is closed afterwards anyway.
 */
const readResponseText = (response: PlaywrightResponse): Promise<string> =>
  withTimeout(response.text(), PAGE_OPERATION_TIMEOUT, "Reading the response timed out").catch(
    () => "",
  );

/**
 * GitHub code line links (`#L12`, `#L12-L15`) are checked against the line numbers of the code view, not an anchor:
 * once the code view is rendered, the line is there or the file is shorter. No long wait for late anchors.
 */
async function isGithubCodeLinePresent(page: Page, lineSelector: string) {
  // The code view (any line number) or the line itself, the page might take a while to render the code view
  if (
    !(await waitForSelectorAttached(
      page,
      `${lineSelector}, ${GITHUB_CODE_LINE_SELECTOR}`,
      HASH_FALLBACK_WAIT_TIMEOUT,
    ))
  ) {
    return false;
  }
  // The code view is rendered: give the line a moment (long files are rendered progressively around the linked line)
  return waitForSelectorAttached(page, lineSelector, HASH_WAIT_TIMEOUT);
}

/**
 * Checks the hash of `url` in the page DOM: waits `HASH_WAIT_TIMEOUT` for its anchor, then (with `deadline`, for the
 * navigated URL only) longer for an anchor rendered late. A quiet page is no proof the anchor is absent (a timer
 * can add it any time), so a missing anchor always takes the whole budget until `deadline`.
 */
async function isHashPresentPlaywright(page: Page, hash: string, url: string, deadline?: number) {
  // All values are escaped, so any hash produces a valid selector
  const selector = getHashSelectors(hash, url).join(", ");
  if (isGithubCodeLineLink(url)) {
    return isGithubCodeLinePresent(page, selector);
  }
  if (await waitForSelectorAttached(page, selector, HASH_WAIT_TIMEOUT)) {
    return true;
  }
  if (deadline === undefined) {
    return false;
  }
  // The page was opened with this URL's hash: the anchor might be rendered late (client-side rendered docs,
  // sections expanded on hash navigation)
  incrementMetric("playwrightLongHashWaits");
  const remaining = deadline - Date.now();
  // A timeout of 0 would mean "no timeout" to Playwright
  return remaining > 0 && waitForSelectorAttached(page, selector, remaining);
}

const getPlaywrightHashResult = async (
  page: Page,
  url: string,
  { status, deadline }: { status: number; deadline?: number },
): Promise<LinkCheckResult> => {
  const hash = new URL(url).hash.replace("#", "");
  if (!hash) {
    return { ok: true, status };
  }

  const note = getSpecialFragmentNote(hash, url);
  if (note) {
    return { ok: true, status, note };
  }

  if (!(await isHashPresentPlaywright(page, hash, url, deadline))) {
    return { ok: false, status, error: "hash not found" };
  }

  return { ok: true, status };
};

const isHashNotFound = (result: LinkCheckResult | undefined): boolean =>
  result?.ok === false && result.error === "hash not found";

/** Playwright checks return a result for every URL, the fallback only satisfies the type checker */
export const resultFor = (results: Map<string, LinkCheckResult>, url: string): LinkCheckResult =>
  results.get(url) ?? { ok: false, error: "unexpected error", errorDetail: `No result for ${url}` };

/**
 * Checks URLs pointing to the same page (same URL without hash) with a single Playwright navigation:
 * navigates to the first URL, then checks the hash of every URL in the same DOM (in parallel).
 * Some pages render different content per hash (e.g. SPA tabs), so a hash not found in the shared DOM gets
 * a dedicated navigation to its exact URL before it is reported as "hash not found".
 * The anchor of the navigated URL is waited for `HASH_WAIT_TIMEOUT` first, and if it is missing, longer,
 * `HASH_FALLBACK_WAIT_TIMEOUT` in total (anchors rendered late).
 * GitHub code line links are checked against the rendered code view instead (see `isGithubCodeLinePresent`).
 * @returns results by URL
 */
export async function checkUrlsOnPageWithPlaywright(
  urls: string[],
): Promise<Map<string, LinkCheckResult>> {
  const results = await checkUrlsInOneNavigation(urls);
  const [firstUrl] = urls;
  // The first URL already had the long wait in the shared navigation
  const notFound = urls.filter((url) => url !== firstUrl && isHashNotFound(results.get(url)));
  // After the shared navigation (its page slot is released), so the fallbacks can't deadlock waiting for slots
  await Promise.all(
    notFound.map(async (url) => {
      incrementMetric("playwrightHashFallbacks");
      const fallback = await checkUrlsInOneNavigation([url]);
      results.set(url, resultFor(fallback, url));
    }),
  );
  return results;
}

async function checkUrlsInOneNavigation(urls: string[]): Promise<Map<string, LinkCheckResult>> {
  const [firstUrl] = urls;
  if (firstUrl === undefined) {
    return new Map();
  }

  // Links reach Playwright after the fetch pass (which blocks private destinations), check again for direct callers.
  // Redirects and page resources to blocked IP literals and localhost names are aborted by the route handler.
  try {
    await assertDestinationAllowed(firstUrl);
  } catch (error) {
    if (error instanceof DestinationNotAllowedError) {
      return new Map(urls.map((url) => [url, getBlockedDestinationResult(error)]));
    }
    throw error;
  }

  const hostLimiter = getHostLimiter();
  // Host to wait for before the next navigation: the navigated URL's, then (after a server error) the final URL's
  let waitForUrl = firstUrl;
  for (let retries = 0; ; retries++) {
    // Back off while the host is paused (after a server error or a 429 of this or another check), before taking a
    // page slot, so the other checks keep the browser busy in the meantime
    await hostLimiter.waitUntilResumed(waitForUrl);
    const outcome = await navigateAndCheck(urls, retries);
    if (outcome instanceof Map) {
      return outcome;
    }
    waitForUrl = outcome.pausedUrl;
  }
}

/** A navigation to retry after a 502, 503 or 504 (the host of `pausedUrl`, the final URL after redirects, is paused) */
type NavigationRetry = { pausedUrl: string };

/**
 * One navigation of `checkUrlsInOneNavigation`. Returns a retry after a 502, 503 or 504 that should be retried
 * (the host of the response is paused for the backoff, see `getServerErrorRetryDelay`).
 */
async function navigateAndCheck(
  urls: string[],
  /** Server error retries done so far */
  retries: number,
): Promise<Map<string, LinkCheckResult> | NavigationRetry> {
  const [firstUrl = ""] = urls;
  const sameForAll = (result: LinkCheckResult) => new Map(urls.map((url) => [url, result]));

  // Browser launch or context errors are not the link's fault, they are thrown (reported as unexpected errors).
  // Errors while navigating and checking the page are reported as broken links.
  return withPage(
    async (page): Promise<Map<string, LinkCheckResult> | NavigationRetry> => {
      try {
        incrementMetric("playwrightNavigations");
        // Heavy resources are blocked (see `withPage`), anchors rendered client-side are waited for below
        const response = await page.goto(firstUrl, {
          waitUntil: "domcontentloaded",
          timeout: PAGE_OPERATION_TIMEOUT,
        });
        if (response && TRANSIENT_SERVER_ERROR_STATUS_CODES.includes(response.status())) {
          const status = response.status();
          const delayMs = getServerErrorRetryDelay(
            retries,
            response.headers()["retry-after"] ?? null,
          );
          if (delayMs === undefined) {
            return sameForAll(getServerErrorResult(status, response.statusText()));
          }
          // After a redirect, the server error comes from the final URL: back off for its host
          const failedUrl = response.url() || firstUrl;
          console.log(formatServerErrorRetry(failedUrl, status, delayMs));
          incrementMetric("serverErrorRetries");
          // The page is closed right away, the retry waits for the pause outside of the page slot
          getHostLimiter().pause(failedUrl, delayMs);
          return { pausedUrl: failedUrl };
        }

        if (response && FORBIDDEN_STATUS_CODES.includes(response.status())) {
          return sameForAll({
            ok: false,
            error: "could not check",
            status: response.status(),
            errorDetail: `${response.statusText()} ${await readResponseText(response)}`,
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
        // The overall budget of the long wait starts with the first check, it includes the regular wait
        const deadline = Date.now() + HASH_FALLBACK_WAIT_TIMEOUT;
        return new Map(
          await Promise.all(
            urls.map(
              async (url) =>
                [
                  url,
                  // Only the navigated URL gets the long wait: the page was opened with its hash
                  await getPlaywrightHashResult(page, url, {
                    status,
                    deadline: url === firstUrl ? deadline : undefined,
                  }),
                ] as const,
            ),
          ),
        );
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
    { userAgent: shouldSpoofUserAgent(firstUrl) ? getRandomUserAgent() : undefined },
  );
}

/**
 * Checks a link with a real browser (the shared browser, see `withPage`).
 * Outside of a run (`checkLinks`, `checkWebsite`...), call `closeRunBrowser()` when done.
 */
export async function checkLinkWithPlaywright(url: string): Promise<LinkCheckResult> {
  const results = await checkUrlsOnPageWithPlaywright([url]);
  return resultFor(results, url);
}
