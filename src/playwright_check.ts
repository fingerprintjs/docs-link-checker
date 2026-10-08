import type { Page, Response as PlaywrightResponse } from "playwright";
import {
  HASH_FALLBACK_WAIT_TIMEOUT,
  HASH_WAIT_TIMEOUT,
  PAGE_OPERATION_TIMEOUT,
  withPage,
} from "./browser";
import { isGithubCodeLineLink } from "./github/gh_url";
import { getHashSelectors } from "./hash";
import {
  FORBIDDEN_STATUS_CODES,
  formatServerErrorRetry,
  USER_AGENT,
  getServerErrorRetryDelay,
  OKAY_STATUS_CODES,
  TRANSIENT_SERVER_ERROR_STATUS_CODES,
} from "./http";
import { withTimeout } from "./limiter";
import { getServerErrorResult, getSpecialFragmentNote, shouldSpoofUserAgent } from "./link_common";
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
 * Checks the hash of `url` in the page DOM: waits `HASH_WAIT_TIMEOUT` for its anchor, then longer until `deadline`
 * (anchors rendered late). A quiet page is no proof the anchor is absent (a timer can add it any time), so a
 * missing anchor always takes the whole budget until `deadline`.
 */
async function isHashPresentPlaywright(page: Page, hash: string, url: string, deadline: number) {
  // All values are escaped, so any hash produces a valid selector
  const selector = getHashSelectors(hash, url).join(", ");
  if (isGithubCodeLineLink(url)) {
    return isGithubCodeLinePresent(page, selector);
  }
  if (await waitForSelectorAttached(page, selector, HASH_WAIT_TIMEOUT)) {
    return true;
  }
  // Client-side rendered docs, sections expanded on hash navigation
  incrementMetric("playwrightLongHashWaits");
  const remaining = deadline - Date.now();
  // A timeout of 0 would mean "no timeout" to Playwright
  return remaining > 0 && waitForSelectorAttached(page, selector, remaining);
}

const getPlaywrightHashResult = async (
  page: Page,
  url: string,
  { status, deadline }: { status: number; deadline: number },
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

const HASH_SET_TIMEOUT_MESSAGE = "Setting the hash timed out";
/** The in-page hash retry hung: the page main thread does not respond */
const HASH_RETRY_HUNG = "hung";

/**
 * Sets the hash of `url` in the open page and waits for its anchor (content rendered per hash), all within one
 * `HASH_WAIT_TIMEOUT`. A failure (e.g. the page navigated away) means not found, a closed page (browser crash) is
 * rethrown. Returns `HASH_RETRY_HUNG` if setting the hash never returns: `page.evaluate` has no Playwright timeout, so
 * a hung page would hold the page slot. The pending call is cancelled when `withPage` closes the context.
 */
async function isHashPresentAfterSettingIt(page: Page, url: string) {
  const { hash } = new URL(url);
  const startedAt = Date.now();
  try {
    await withTimeout(
      page.evaluate((newHash) => {
        location.hash = newHash;
      }, hash),
      HASH_WAIT_TIMEOUT,
      HASH_SET_TIMEOUT_MESSAGE,
    );
    // A timeout of 0 would mean "no timeout" to Playwright
    const remaining = HASH_WAIT_TIMEOUT - (Date.now() - startedAt);
    return (
      remaining > 0 &&
      (await waitForSelectorAttached(
        page,
        getHashSelectors(hash.slice(1), url).join(", "),
        remaining,
      ))
    );
  } catch (error) {
    if (page.isClosed()) {
      throw error;
    }
    return error instanceof Error && error.message === HASH_SET_TIMEOUT_MESSAGE
      ? HASH_RETRY_HUNG
      : false;
  }
}

/**
 * Checks URLs pointing to the same page (same URL without hash) with a single Playwright navigation:
 * navigates to the first URL, then waits for the hash of every URL in the same DOM (in parallel), all until one
 * deadline, `HASH_FALLBACK_WAIT_TIMEOUT` after the first check (anchors rendered late).
 * Some pages render different content per hash (e.g. SPA tabs): a hash still missing then is set in the same page
 * (one hash at a time) and waited for `HASH_WAIT_TIMEOUT` more, before it is reported as "hash not found".
 * GitHub code line links are checked against the rendered code view instead (see `isGithubCodeLinePresent`).
 * @returns results by URL
 */
export async function checkUrlsOnPageWithPlaywright(
  urls: string[],
): Promise<Map<string, LinkCheckResult>> {
  const [firstUrl] = urls;
  if (firstUrl === undefined) {
    return new Map();
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
 * One navigation of `checkUrlsOnPageWithPlaywright`. Returns a retry after a 502, 503 or 504 that should be retried
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
        const results = new Map(
          await Promise.all(
            urls.map(
              async (url) =>
                [
                  url,
                  await getPlaywrightHashResult(page, url, {
                    status,
                    deadline,
                  }),
                ] as const,
            ),
          ),
        );
        // The page was opened with the first URL's hash, the others might be rendered only after their hash is set
        for (const url of urls.slice(1)) {
          if (isHashNotFound(results.get(url)) && !isGithubCodeLineLink(url)) {
            incrementMetric("playwrightHashFallbacks");
            const found = await isHashPresentAfterSettingIt(page, url);
            if (found === HASH_RETRY_HUNG) {
              // The page would hang again for the next hashes
              break;
            }
            if (found) {
              results.set(url, { ok: true, status });
            }
          }
        }
        return results;
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
    {
      userAgent: shouldSpoofUserAgent(firstUrl) ? USER_AGENT : undefined,
    },
  );
}
