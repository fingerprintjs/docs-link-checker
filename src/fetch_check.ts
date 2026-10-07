import { Headers } from "undici";
import { DestinationNotAllowedError } from "./destination";
import { type AnchorIndex, buildAnchorIndex, isHashInAnchorIndex } from "./hash";
import {
  fetchWithHostLimit,
  getRandomUserAgent,
  OKAY_STATUS_CODES,
  TRANSIENT_SERVER_ERROR_STATUS_CODES,
} from "./http";
import {
  getBlockedDestinationResult,
  getServerErrorResult,
  getSpecialFragmentNote,
  hasHash,
  shouldSpoofUserAgent,
  stripHash,
} from "./link_common";
import { incrementMetric } from "./run";
import type { LinkCheckResult } from "./types";

/**
 * A failed HEAD request is retried once with GET: some servers refuse HEAD (403, 405, 501) and some answer it
 * differently than GET (support.google.com and chatgpt.com return 404 to HEAD and 200 to GET).
 * Not on 429: the host is rate limiting, another request would not help (see `fetchWithHostLimit`).
 */
const shouldRetryHeadWithGet = (status: number): boolean =>
  !OKAY_STATUS_CODES.includes(status) && status !== 429;

/**
 * Result of fetching a page (URL without hash): either a final failure, or the status and the anchors of the page.
 */
export type FetchedPage =
  | { ok: true; status: number; getAnchors?: () => AnchorIndex }
  | { ok: false; result: LinkCheckResult };

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

/**
 * Fetches a page with `GET` (if its HTML is needed) or `HEAD` (falls back to `GET` if HEAD fails, see
 * `shouldRetryHeadWithGet`).
 * Limited per host, honours `Retry-After` on 429 (pauses the whole host), retries 502, 503 and 504. Never throws.
 */
const fetchPage = async (
  url: string,
  { needBody }: { needBody: boolean },
): Promise<FetchedPage> => {
  const headers = new Headers();
  if (shouldSpoofUserAgent(url)) {
    headers.set("User-Agent", getRandomUserAgent());
  }

  // Limited per host (every redirect hop too), a 429 with Retry-After pauses the host and is retried,
  // unread bodies are cancelled (see `fetchWithHostLimit`).
  // HEAD is sent with no server-error retries, so a failing server is not asked for it twice before the GET
  // fallback (see `shouldRetryHeadWithGet`), which gets the normal retry policy.
  const request = (method: "GET" | "HEAD") =>
    fetchWithHostLimit(
      url,
      { method, headers, serverErrorRetries: method === "HEAD" ? 0 : undefined },
      async (response) =>
        // Don't download the body when it's not needed (it might be a large file), it is cancelled instead.
        // An error page body is kept for the error detail (HEAD responses have none).
        method === "GET" && (needBody || !OKAY_STATUS_CODES.includes(response.status))
          ? response.text()
          : "",
    );

  try {
    let response = await request(needBody ? "GET" : "HEAD");
    // Some servers don't support (or block) HEAD requests, or answer them differently, retry once with GET
    if (!needBody && shouldRetryHeadWithGet(response.status)) {
      response = await request("GET");
    }

    // Still rate limited after the retries (GitHub web rate limit makes you wait 60 seconds after 500 requests)
    const retryAfter = response.headers.get("Retry-After");
    if (response.status === 429 && retryAfter) {
      return {
        ok: false,
        result: {
          ok: false,
          error: "unexpected error",
          status: response.status,
          // Raw header without a unit: it can be seconds or an HTTP date
          errorDetail: `\n Rate limited and gave up, Retry-After: ${retryAfter} for link ${url}`,
        },
      };
    }

    // Still failing after the retries (see `fetchWithHostLimit`): the server is overloaded, not the link broken
    if (TRANSIENT_SERVER_ERROR_STATUS_CODES.includes(response.status)) {
      return { ok: false, result: getServerErrorResult(response.status, response.statusText) };
    }

    if (!OKAY_STATUS_CODES.includes(response.status)) {
      return {
        ok: false,
        result: {
          ok: false,
          error: "broken link",
          status: response.status,
          errorDetail: `${response.statusText} ${response.data}`,
        },
      };
    }

    return {
      ok: true,
      status: response.status,
      getAnchors: needBody ? lazyAnchorIndex(response.data) : undefined,
    };
  } catch (error) {
    if (error instanceof DestinationNotAllowedError) {
      return { ok: false, result: getBlockedDestinationResult(error) };
    }
    return {
      ok: false,
      result: {
        ok: false,
        error: "broken link",
        errorDetail: String(error),
      },
    };
  }
};

/**
 * Page fetches of a single `checkLinks` call, keyed by URL without hash: each page is fetched once,
 * no matter how many links (with different hashes) point to it.
 */
export class PageFetchCache {
  private readonly pages = new Map<string, Promise<FetchedPage>>();

  /**
   * @param pagesWithHash pages (URLs without hash) that are linked with a hash somewhere. They are fetched with GET
   * right away, also for links without a hash, so the page is not fetched twice (HEAD and GET).
   */
  constructor(private readonly pagesWithHash: ReadonlySet<string> = new Set()) {}

  get(pageUrl: string, needBody: boolean): Promise<FetchedPage> {
    const getKey = `GET ${pageUrl}`;
    const useGet = needBody || this.pagesWithHash.has(pageUrl) || this.pages.has(getKey);
    const key = useGet ? getKey : `HEAD ${pageUrl}`;
    let page = this.pages.get(key);
    if (!page) {
      incrementMetric("uniquePagesFetched");
      page = fetchPage(pageUrl, { needBody: useGet });
      this.pages.set(key, page);
    }
    return page;
  }
}

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

  if (!page.getAnchors || !isHashInAnchorIndex(page.getAnchors(), hash, url)) {
    return { ok: false, status: page.status, error: "hash not found" };
  }
  return { ok: true, status: page.status };
};

/**
 * Check a link with fetch, assuming page is server-side rendered
 * @param url link URL
 * @param pageCache share page fetches between links (links to the same page with different hashes fetch it once)
 * @returns LinkCheckResult, a URL that cannot be parsed is reported as a broken link
 */
export const checkLinkWithFetch = async (
  url: string,
  pageCache?: PageFetchCache,
): Promise<LinkCheckResult> => {
  // A URL that cannot be parsed (or is not http(s)) is a broken link, not an exception
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch (error) {
    return { ok: false, error: "broken link", errorDetail: `Invalid URL: ${String(error)}` };
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return {
      ok: false,
      error: "broken link",
      errorDetail: `Unsupported URL scheme: ${parsedUrl.protocol}`,
    };
  }
  const needBody = hasHash(url);
  const pageUrl = stripHash(url);
  const page = pageCache
    ? await pageCache.get(pageUrl, needBody)
    : await fetchPage(pageUrl, { needBody });
  return getResultFromPage(page, url);
};
