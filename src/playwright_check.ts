/**
 * Checks the hashes of URLs of one page in the DOM with Playwright.
 * - https://playwright.dev/docs/api/class-locator#locator-wait-for
 */
import { Clock, Effect, Option } from "effect";
import type { Page, Response as PlaywrightResponse } from "playwright";
import { Browser, tryPlaywright } from "./browser";
import type { PlaywrightError } from "./errors";
import { isGithubCodeLineLink } from "./github/gh_url";
import { getHashSelectors, getSpecialFragmentNote } from "./hash";
import { classifyStatus, getUserAgent, planServerErrorRetry, serverErrorResult } from "./http";
import { HostLimiter } from "./limiter";
import { Metrics } from "./metrics";
import type { LinkCheckResult } from "./types";

// Timeout of every Playwright page operation (a navigation, a wait...), so each check is bounded on its own
export const PAGE_OPERATION_TIMEOUT = 30000;
// How long a hash is waited for after the page loaded (client-side rendered anchors)
export const HASH_WAIT_TIMEOUT = 3000;
// A hash still missing after HASH_WAIT_TIMEOUT is waited for longer, together with the other hashes of its page.
// This is the overall budget of the page, counted from the first check (HASH_WAIT_TIMEOUT included): a missing
// anchor takes all of it.
// E.g. Mintlify docs expand collapsed sections and add their ids several seconds after hydration.
export const HASH_FALLBACK_WAIT_TIMEOUT = 15000;

/** Waits up to `timeout` for an element matching `selector` to be in the DOM. A timeout is `false`, not an error. */
const waitForSelectorAttached = (
  page: Page,
  selector: string,
  timeout: number,
): Effect.Effect<boolean, PlaywrightError> =>
  // Wait for the element to be in the DOM (client-side rendered pages add it later).
  // Anchors like `<a id="x"></a>` are valid targets but never "visible", so visibility is not required.
  tryPlaywright(() => page.locator(selector).first().waitFor({ state: "attached", timeout })).pipe(
    Effect.as(true),
    Effect.catchIf(
      (error) => error.cause instanceof Error && error.cause.name === "TimeoutError",
      () => Effect.succeed(false),
    ),
  );

// Line numbers of the GitHub code view (`<div data-line-number="12">`)
const GITHUB_CODE_LINE_SELECTOR = "[data-line-number]";

/**
 * Body of a navigation response, `""` if it can't be read within `PAGE_OPERATION_TIMEOUT` (Playwright has no timeout
 * for response bodies, a body that never ends would hold the page slot). The page is closed afterwards anyway.
 */
const readResponseText = (response: PlaywrightResponse): Effect.Effect<string> =>
  tryPlaywright(() => response.text()).pipe(
    Effect.timeout(PAGE_OPERATION_TIMEOUT),
    Effect.orElseSucceed(() => ""),
  );

/**
 * GitHub code line links (`#L12`, `#L12-L15`) are checked against the line numbers of the code view, not an anchor:
 * once the code view is rendered, the line is there or the file is shorter. No long wait for late anchors.
 */
const isGithubCodeLinePresent = (page: Page, lineSelector: string) =>
  Effect.gen(function* () {
    // The code view (any line number) or the line itself, the page might take a while to render the code view
    const hasCodeView = yield* waitForSelectorAttached(
      page,
      `${lineSelector}, ${GITHUB_CODE_LINE_SELECTOR}`,
      HASH_FALLBACK_WAIT_TIMEOUT,
    );
    if (!hasCodeView) {
      return false;
    }
    // The code view is rendered: give the line a moment (long files are rendered progressively around the linked line)
    return yield* waitForSelectorAttached(page, lineSelector, HASH_WAIT_TIMEOUT);
  });

/**
 * Checks the hash of `url` in the page DOM: waits `HASH_WAIT_TIMEOUT` for its anchor, then longer until `deadline`
 * (anchors rendered late). A quiet page is no proof the anchor is absent (a timer can add it any time), so a
 * missing anchor always takes the whole budget until `deadline`.
 */
const isHashPresent = (page: Page, hash: string, url: string, deadline: number) =>
  Effect.gen(function* () {
    // All values are escaped, so any hash produces a valid selector
    const selector = getHashSelectors(hash, url).join(", ");
    if (isGithubCodeLineLink(url)) {
      return yield* isGithubCodeLinePresent(page, selector);
    }
    if (yield* waitForSelectorAttached(page, selector, HASH_WAIT_TIMEOUT)) {
      return true;
    }
    // Client-side rendered docs, sections expanded on hash navigation
    yield* (yield* Metrics).increment("playwrightLongHashWaits");
    const remaining = deadline - (yield* Clock.currentTimeMillis);
    // A timeout of 0 would mean "no timeout" to Playwright
    return remaining > 0 && (yield* waitForSelectorAttached(page, selector, remaining));
  });

const getHashResult = (
  page: Page,
  url: string,
  { status, deadline }: { readonly status: number; readonly deadline: number },
): Effect.Effect<LinkCheckResult, PlaywrightError, Metrics> =>
  Effect.gen(function* () {
    const hash = new URL(url).hash.replace("#", "");
    if (!hash) {
      return { ok: true, status };
    }
    const note = getSpecialFragmentNote(hash, url);
    if (note) {
      return { ok: true, status, note };
    }
    return (yield* isHashPresent(page, hash, url, deadline))
      ? { ok: true, status }
      : { ok: false, status, error: "hash not found" };
  });

const isHashNotFound = (result: LinkCheckResult | undefined): boolean =>
  result?.ok === false && result.error === "hash not found";

/** The in-page hash retry hung: the page main thread does not respond */
const HASH_RETRY_HUNG = "hung";

/**
 * Sets the hash of `url` in the open page and waits for its anchor (content rendered per hash), all within one
 * `HASH_WAIT_TIMEOUT`. A failure (e.g. the page navigated away) means not found, a closed page (browser crash) is
 * a failure of the effect. Returns `HASH_RETRY_HUNG` if setting the hash never returns: `page.evaluate` has no
 * Playwright timeout, so a hung page would hold the page slot. The pending call is cancelled when the page scope
 * of `withPage` closes the context.
 */
const isHashPresentAfterSettingIt = (page: Page, url: string) =>
  Effect.gen(function* () {
    const { hash } = new URL(url);
    const startedAt = yield* Clock.currentTimeMillis;
    const isSet = yield* tryPlaywright(() =>
      page.evaluate((newHash) => {
        location.hash = newHash;
      }, hash),
    ).pipe(Effect.timeoutOption(HASH_WAIT_TIMEOUT));
    if (Option.isNone(isSet)) {
      return HASH_RETRY_HUNG;
    }
    // A timeout of 0 would mean "no timeout" to Playwright
    const remaining = HASH_WAIT_TIMEOUT - ((yield* Clock.currentTimeMillis) - startedAt);
    return (
      remaining > 0 &&
      (yield* waitForSelectorAttached(
        page,
        getHashSelectors(hash.slice(1), url).join(", "),
        remaining,
      ))
    );
  }).pipe(
    // A closed page is a browser crash, `withPage` relaunches
    Effect.catchAll((error) => (page.isClosed() ? Effect.fail(error) : Effect.succeed(false))),
  );

/** A navigation to retry after a 502, 503 or 504 (the host of `pausedUrl`, the final URL after redirects, is paused) */
type NavigationRetry = { readonly pausedUrl: string };

/** Hashes of all `urls` in the DOM of the loaded `page`, all until one deadline (see `checkUrlsOnPageWithPlaywright`) */
const checkHashesInPage = (page: Page, urls: ReadonlyArray<string>, status: number) =>
  Effect.gen(function* () {
    // The overall budget of the long wait starts with the first check, it includes the regular wait
    const deadline = (yield* Clock.currentTimeMillis) + HASH_FALLBACK_WAIT_TIMEOUT;
    const results = new Map(
      yield* Effect.forEach(
        urls,
        (url) =>
          getHashResult(page, url, { status, deadline }).pipe(
            Effect.map((result) => [url, result] as const),
          ),
        { concurrency: "unbounded" },
      ),
    );
    // The page was opened with the first URL's hash, the others might be rendered only after their hash is set
    for (const url of urls.slice(1)) {
      if (isHashNotFound(results.get(url)) && !isGithubCodeLineLink(url)) {
        yield* (yield* Metrics).increment("playwrightHashFallbacks");
        const found = yield* isHashPresentAfterSettingIt(page, url);
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
  });

/** Navigates to the first URL and checks all `urls` in the loaded page */
const checkLoadedPage = (
  page: Page,
  urls: ReadonlyArray<string>,
  firstUrl: string,
  retries: number,
) =>
  Effect.gen(function* () {
    const sameForAll = (result: LinkCheckResult) => new Map(urls.map((url) => [url, result]));
    yield* (yield* Metrics).increment("playwrightNavigations");
    // Heavy resources are blocked (see `withPage`), anchors rendered client-side are waited for below
    const response = yield* tryPlaywright(() =>
      page.goto(firstUrl, { waitUntil: "domcontentloaded", timeout: PAGE_OPERATION_TIMEOUT }),
    );
    // No response for navigations that load no document (e.g. a hash change on the same page)
    if (!response) {
      return sameForAll({ ok: false, error: "broken link", status: 0 });
    }
    const status = response.status();
    const statusClass = classifyStatus(status);

    if (statusClass === "server-error") {
      // After a redirect, the server error comes from the final URL: back off for its host
      const failedUrl = response.url() || firstUrl;
      const delayMs = yield* planServerErrorRetry({
        url: failedUrl,
        status,
        retries,
        retryAfter: response.headers()["retry-after"] ?? null,
      });
      if (Option.isNone(delayMs)) {
        return sameForAll(serverErrorResult(status, response.statusText()));
      }
      // The page is closed right away, the retry waits for the pause outside of the page slot
      yield* (yield* HostLimiter).pause(failedUrl, delayMs.value);
      return { pausedUrl: failedUrl } satisfies NavigationRetry;
    }
    if (statusClass === "forbidden") {
      return sameForAll({
        ok: false,
        error: "could not check",
        status,
        errorDetail: `${response.statusText()} ${yield* readResponseText(response)}`,
      });
    }
    if (statusClass !== "okay") {
      return sameForAll({ ok: false, error: "broken link", status });
    }
    return yield* checkHashesInPage(page, urls, status);
  });

/**
 * One navigation of `checkUrlsOnPageWithPlaywright`. Returns a retry after a 502, 503 or 504 that should be retried
 * (the host of the response is paused for the backoff, see `planServerErrorRetry`).
 */
const navigateAndCheck = (
  urls: ReadonlyArray<string>,
  /** Server error retries done so far */
  retries: number,
) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const firstUrl = urls[0] ?? "";
    // Browser launch or context errors are not the link's fault, they fail the effect (reported as unexpected errors).
    // Errors while navigating and checking the page are reported as broken links.
    return yield* browser.withPage(
      { userAgent: getUserAgent(firstUrl), timeout: PAGE_OPERATION_TIMEOUT },
      (page) =>
        checkLoadedPage(page, urls, firstUrl, retries).pipe(
          Effect.catchAll((error) =>
            // The browser crashed: let `withPage` relaunch it and retry
            page.isClosed()
              ? Effect.fail(error)
              : Effect.succeed(
                  new Map(
                    urls.map((url): [string, LinkCheckResult] => [
                      url,
                      { ok: false, error: "broken link", errorDetail: String(error.cause) },
                    ]),
                  ),
                ),
          ),
        ),
    );
  });

/**
 * Checks URLs pointing to the same page (same URL without hash) with a single Playwright navigation:
 * navigates to the first URL, then waits for the hash of every URL in the same DOM (in parallel), all until one
 * deadline, `HASH_FALLBACK_WAIT_TIMEOUT` after the first check (anchors rendered late).
 * Some pages render different content per hash (e.g. SPA tabs): a hash still missing then is set in the same page
 * (one hash at a time) and waited for `HASH_WAIT_TIMEOUT` more, before it is reported as "hash not found".
 * GitHub code line links are checked against the rendered code view instead (see `isGithubCodeLinePresent`).
 * Returns results by URL.
 */
export const checkUrlsOnPageWithPlaywright = Effect.fn("playwright_check.checkUrlsOnPage")(
  function* (urls: ReadonlyArray<string>) {
    const [firstUrl] = urls;
    if (firstUrl === undefined) {
      return new Map<string, LinkCheckResult>();
    }
    const hostLimiter = yield* HostLimiter;
    // Host to wait for before the next navigation: the navigated URL's, then (after a server error) the final URL's
    let waitForUrl = firstUrl;
    for (let retries = 0; ; retries++) {
      // Back off while the host is paused (after a server error or a 429 of this or another check), before taking a
      // page slot, so the other checks keep the browser busy in the meantime
      yield* hostLimiter.waitUntilResumed(waitForUrl);
      const outcome = yield* navigateAndCheck(urls, retries);
      if (outcome instanceof Map) {
        return outcome;
      }
      waitForUrl = outcome.pausedUrl;
    }
  },
);
