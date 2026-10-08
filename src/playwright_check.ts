// Playwright re-check of links: one navigation per page, every hash is looked up in the same DOM.
// Pages are scoped resources, see `withPage` in browser.ts.
import { Clock, Effect } from "effect";
import type { Page, Response as PlaywrightResponse } from "playwright";
import { type PageError, tryPage, withPage } from "./browser";
import { isGithubCodeLineLink } from "./github/gh_url";
import { getHashSelectors, getSpecialFragmentNote } from "./hash";
import { classifyStatus, getUserAgent, planServerErrorRetry, serverErrorResult } from "./http";
import { HostLimiter } from "./limiter";
import { incrementMetric } from "./run";
import type { LinkCheckResult } from "./types";
import { TimeoutError } from "./utils/errors";

// Timeout of every Playwright page operation (a navigation, a wait...), so each check is bounded on its own
export const PAGE_OPERATION_TIMEOUT = 30000;
// How long a hash is waited for after the page loaded (client-side rendered anchors)
export const HASH_WAIT_TIMEOUT = 3000;
// A hash still missing after HASH_WAIT_TIMEOUT is waited for longer, together with the other hashes of its page.
// This is the overall budget of the page, counted from the first check (HASH_WAIT_TIMEOUT included): a missing
// anchor takes all of it.
// E.g. Mintlify docs expand collapsed sections and add their ids several seconds after hydration.
export const HASH_FALLBACK_WAIT_TIMEOUT = 15000;

const isPlaywrightTimeout = (error: PageError) =>
  error.cause instanceof Error && error.cause.name === "TimeoutError";

/** Waits up to `timeout` for an element matching `selector` to be in the DOM, `false` if it is not there in time */
const waitForSelectorAttached = (page: Page, selector: string, timeout: number) =>
  // Wait for the element to be in the DOM (client-side rendered pages add it later).
  // Anchors like `<a id="x"></a>` are valid targets but never "visible", so visibility is not required.
  tryPage(() => page.locator(selector).first().waitFor({ state: "attached", timeout })).pipe(
    Effect.as(true),
    Effect.catchIf(isPlaywrightTimeout, () => Effect.succeed(false)),
  );

// Line numbers of the GitHub code view (`<div data-line-number="12">`)
const GITHUB_CODE_LINE_SELECTOR = "[data-line-number]";

/**
 * Body of a navigation response, `""` if it can't be read within `PAGE_OPERATION_TIMEOUT` (Playwright has no timeout
 * for response bodies, a body that never ends would hold the page slot). The page is closed afterwards anyway.
 */
const readResponseText = (response: PlaywrightResponse) =>
  tryPage(() => response.text()).pipe(
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
    const codeViewRendered = yield* waitForSelectorAttached(
      page,
      `${lineSelector}, ${GITHUB_CODE_LINE_SELECTOR}`,
      HASH_FALLBACK_WAIT_TIMEOUT,
    );
    // The code view is rendered: give the line a moment (long files are rendered progressively around the linked line)
    return (
      codeViewRendered && (yield* waitForSelectorAttached(page, lineSelector, HASH_WAIT_TIMEOUT))
    );
  });

/**
 * Checks the hash of `url` in the page DOM: waits `HASH_WAIT_TIMEOUT` for its anchor, then longer until `deadline`
 * (anchors rendered late). A quiet page is no proof the anchor is absent (a timer can add it any time), so a
 * missing anchor always takes the whole budget until `deadline`.
 */
const isHashPresentPlaywright = (page: Page, hash: string, url: string, deadline: number) =>
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
    yield* incrementMetric("playwrightLongHashWaits");
    const remaining = deadline - (yield* Clock.currentTimeMillis);
    // A timeout of 0 would mean "no timeout" to Playwright
    return remaining > 0 && (yield* waitForSelectorAttached(page, selector, remaining));
  });

const getPlaywrightHashResult = (
  page: Page,
  url: string,
  { status, deadline }: { status: number; deadline: number },
) =>
  Effect.gen(function* () {
    const hash = new URL(url).hash.replace("#", "");
    if (!hash) {
      return { ok: true, status } satisfies LinkCheckResult;
    }

    const note = getSpecialFragmentNote(hash, url);
    if (note) {
      return { ok: true, status, note } satisfies LinkCheckResult;
    }

    if (!(yield* isHashPresentPlaywright(page, hash, url, deadline))) {
      return { ok: false, status, error: "hash not found" } satisfies LinkCheckResult;
    }

    return { ok: true, status } satisfies LinkCheckResult;
  });

const isHashNotFound = (result: LinkCheckResult | undefined): boolean =>
  result?.ok === false && result.error === "hash not found";

/** The in-page hash retry hung: the page main thread does not respond */
const HASH_RETRY_HUNG = "hung";

/**
 * Sets the hash of `url` in the open page and waits for its anchor (content rendered per hash), all within one
 * `HASH_WAIT_TIMEOUT`. A failure (e.g. the page navigated away) means not found, a closed page (browser crash) fails.
 * Returns `HASH_RETRY_HUNG` if setting the hash never returns: `page.evaluate` has no Playwright timeout, so
 * a hung page would hold the page slot. The timeout interrupts the call, the context is closed with the scope.
 */
const isHashPresentAfterSettingIt = (page: Page, url: string) =>
  Effect.gen(function* () {
    const { hash } = new URL(url);
    const startedAt = yield* Clock.currentTimeMillis;
    yield* tryPage(() =>
      page.evaluate((newHash) => {
        location.hash = newHash;
      }, hash),
    ).pipe(
      Effect.timeoutFail({
        duration: HASH_WAIT_TIMEOUT,
        onTimeout: () =>
          new TimeoutError({ message: "Setting the hash timed out", timeoutMs: HASH_WAIT_TIMEOUT }),
      }),
    );
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
    Effect.catchAll((error) =>
      page.isClosed()
        ? Effect.fail(error)
        : Effect.succeed(error instanceof TimeoutError ? HASH_RETRY_HUNG : false),
    ),
  );

/** A navigation to retry after a 502, 503 or 504 (the host of `pausedUrl`, the final URL after redirects, is paused) */
type NavigationRetry = { pausedUrl: string };

/**
 * One navigation of `checkUrlsOnPageWithPlaywright`. Returns a retry after a 502, 503 or 504 that should be retried
 * (the host of the response is paused for the backoff, see `planServerErrorRetry`).
 */
const navigateAndCheck = (
  urls: string[],
  /** Server error retries done so far */
  retries: number,
) =>
  Effect.gen(function* () {
    const [firstUrl = ""] = urls;
    const hostLimiter = yield* HostLimiter;
    const sameForAll = (result: LinkCheckResult) =>
      new Map<string, LinkCheckResult>(urls.map((url) => [url, result]));

    const checkPage = (page: Page) =>
      Effect.gen(function* () {
        yield* incrementMetric("playwrightNavigations");
        // Heavy resources are blocked (see `withPage`), anchors rendered client-side are waited for below
        const response = yield* tryPage(() =>
          page.goto(firstUrl, { waitUntil: "domcontentloaded", timeout: PAGE_OPERATION_TIMEOUT }),
        );
        if (!response) {
          return sameForAll({ ok: false, error: "broken link", status: 0 });
        }
        const status = response.status();
        const statusClass = classifyStatus(status);
        if (statusClass === "server-error") {
          // After a redirect, the server error comes from the final URL: back off for its host
          const failedUrl = response.url() || firstUrl;
          const delayMs = yield* planServerErrorRetry(
            failedUrl,
            status,
            retries,
            response.headers()["retry-after"] ?? null,
          );
          if (delayMs === undefined) {
            return sameForAll(serverErrorResult(status, response.statusText()));
          }
          // The page is closed right away, the retry waits for the pause outside of the page slot
          yield* hostLimiter.pause(failedUrl, delayMs);
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

        // The overall budget of the long wait starts with the first check, it includes the regular wait
        const deadline = (yield* Clock.currentTimeMillis) + HASH_FALLBACK_WAIT_TIMEOUT;
        const results = new Map<string, LinkCheckResult>(
          yield* Effect.all(
            urls.map((url) =>
              getPlaywrightHashResult(page, url, { status, deadline }).pipe(
                Effect.map((result) => [url, result] as const),
              ),
            ),
            { concurrency: "unbounded" },
          ),
        );
        // The page was opened with the first URL's hash, the others might be rendered only after their hash is set
        for (const url of urls.slice(1)) {
          if (isHashNotFound(results.get(url)) && !isGithubCodeLineLink(url)) {
            yield* incrementMetric("playwrightHashFallbacks");
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
      }).pipe(
        // Errors while navigating and checking the page are reported as broken links, unless the browser crashed:
        // then `withPage` relaunches it and retries
        Effect.catchAll((error) =>
          page.isClosed()
            ? Effect.fail(error)
            : Effect.succeed(
                sameForAll({ ok: false, error: "broken link", errorDetail: String(error) }),
              ),
        ),
      );

    // Browser launch or context errors are not the link's fault, they fail (reported as unexpected errors)
    return yield* withPage(checkPage, {
      userAgent: getUserAgent(firstUrl),
      timeout: PAGE_OPERATION_TIMEOUT,
    });
  });

/**
 * Checks URLs pointing to the same page (same URL without hash) with a single Playwright navigation:
 * navigates to the first URL, then waits for the hash of every URL in the same DOM (in parallel), all until one
 * deadline, `HASH_FALLBACK_WAIT_TIMEOUT` after the first check (anchors rendered late).
 * Some pages render different content per hash (e.g. SPA tabs): a hash still missing then is set in the same page
 * (one hash at a time) and waited for `HASH_WAIT_TIMEOUT` more, before it is reported as "hash not found".
 * GitHub code line links are checked against the rendered code view instead (see `isGithubCodeLinePresent`).
 * Fails with `BrowserLaunchError` or `PageError` (crashed browser) only, any other problem is a broken link result.
 * @returns results by URL
 */
export const checkUrlsOnPageWithPlaywright = (urls: string[]) =>
  Effect.gen(function* () {
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
  });
