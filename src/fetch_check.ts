/**
 * Link check with plain `fetch`: one fetch per page (`PageCache`), hashes checked against the HTML anchors.
 * Assumes the page is server-side rendered, a failure that client-side rendering could cause is re-checked
 * with Playwright by `link.ts`.
 */
import { Cache, Duration, Effect } from "effect";
import {
  type AnchorIndex,
  buildAnchorIndex,
  getSpecialFragmentNote,
  hasHash,
  isHashInAnchorIndex,
  stripHash,
} from "./hash";
import { classifyStatus, type Fetch, fetchLimited, getUserAgent, serverErrorResult } from "./http";
import type { HostLimiter } from "./limiter";
import { Metrics } from "./metrics";
import type { LinkCheckResult } from "./types";

/** Result of fetching a page (URL without hash): a final failure, or the status and the anchors of the page */
export type FetchedPage =
  | { readonly ok: true; readonly status: number; readonly getAnchors?: () => AnchorIndex }
  | { readonly ok: false; readonly result: LinkCheckResult };

/** Key: page URL without hash */
export type PageCache = Cache.Cache<string, FetchedPage>;

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

const failed = (result: LinkCheckResult): FetchedPage => ({ ok: false, result });

/**
 * Fetches a page with `GET`, also when only its status matters: some servers refuse `HEAD` or answer it differently
 * (support.google.com and chatgpt.com return 404 to HEAD and 200 to GET), and a failed HEAD needed a second request.
 * Never fails: errors and bad statuses are results.
 */
const fetchPage = (
  url: string,
  { needBody }: { readonly needBody: boolean },
): Effect.Effect<FetchedPage, never, Fetch | HostLimiter | Metrics> =>
  Effect.gen(function* () {
    const userAgent = getUserAgent(url);
    const response = yield* fetchLimited(
      url,
      { headers: userAgent ? { "User-Agent": userAgent } : undefined },
      // Don't download the body when it's not needed (it might be a large file), it is cancelled instead.
      // An error page body is kept for the error detail.
      (res) =>
        needBody || classifyStatus(res.status) !== "okay" ? res.text() : Promise.resolve(""),
    );

    // Still rate limited after the retries (GitHub web rate limit makes you wait 60 seconds after 500 requests)
    const retryAfter = response.headers.get("Retry-After");
    if (response.status === 429 && retryAfter) {
      return failed({
        ok: false,
        error: "unexpected error",
        status: response.status,
        // Raw header without a unit: it can be seconds or an HTTP date
        errorDetail: `\n Rate limited and gave up, Retry-After: ${retryAfter} for link ${url}`,
      });
    }

    // Still failing after the retries: the server is overloaded, the link is not necessarily broken
    const statusClass = classifyStatus(response.status);
    if (statusClass === "server-error") {
      return failed(serverErrorResult(response.status, response.statusText));
    }

    // 401 and 403 are broken here on purpose: they are re-checked with Playwright, which reports "could not check"
    if (statusClass !== "okay") {
      return failed({
        ok: false,
        error: "broken link",
        status: response.status,
        errorDetail: `${response.statusText} ${response.data}`,
      });
    }

    return {
      ok: true,
      status: response.status,
      getAnchors: needBody ? lazyAnchorIndex(response.data) : undefined,
    } satisfies FetchedPage;
  }).pipe(
    Effect.catchAll((error) =>
      Effect.succeed(failed({ ok: false, error: "broken link", errorDetail: String(error) })),
    ),
  );

/**
 * Each page is fetched once, no matter how many links (with different hashes) point to it.
 * @param pagesWithHash pages (URLs without hash) that are linked with a hash somewhere. Their body is read, also
 * for links without a hash, so the page is not fetched twice.
 */
export const makePageCache = (
  pagesWithHash: ReadonlySet<string>,
): Effect.Effect<PageCache, never, Fetch | HostLimiter | Metrics> =>
  Cache.make({
    capacity: Number.MAX_SAFE_INTEGER,
    timeToLive: Duration.infinity,
    lookup: (pageUrl: string) =>
      Effect.flatMap(Metrics, (metrics) => metrics.increment("uniquePagesFetched")).pipe(
        Effect.zipRight(fetchPage(pageUrl, { needBody: pagesWithHash.has(pageUrl) })),
      ),
  });

/** Result for a URL (possibly with a hash) based on its fetched page */
const getResultFromPage = (page: FetchedPage, url: string): LinkCheckResult => {
  if (!page.ok) {
    return page.result;
  }
  const hash = new URL(url).hash;
  if (!hash) {
    return { ok: true, status: page.status };
  }

  const note = getSpecialFragmentNote(hash.slice(1), url);
  if (note) {
    return { ok: true, status: page.status, note };
  }

  if (!page.getAnchors || !isHashInAnchorIndex(page.getAnchors(), hash)) {
    return { ok: false, status: page.status, error: "hash not found" };
  }
  return { ok: true, status: page.status };
};

/**
 * Checks a link with fetch. Expects a valid http(s) URL, `checkLinks` reports other URLs as invalid before
 * getting here.
 * @param pageCache shares page fetches between links (links to the same page with different hashes fetch it once)
 */
export const checkLinkWithFetch = (
  url: string,
  pageCache?: PageCache,
): Effect.Effect<LinkCheckResult, never, Fetch | HostLimiter | Metrics> =>
  Effect.gen(function* () {
    const pageUrl = stripHash(url);
    const page = pageCache
      ? yield* pageCache.get(pageUrl)
      : yield* fetchPage(pageUrl, { needBody: hasHash(url) });
    return getResultFromPage(page, url);
  });
