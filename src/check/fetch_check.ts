import { incrementMetric } from "../run";
import type { LinkCheckResult } from "../types";
import {
  type AnchorIndex,
  buildAnchorIndex,
  getSpecialFragmentNote,
  hasHash,
  isHashInAnchorIndex,
  stripHash,
} from "./hash";
import {
  classifyStatus,
  fetchWithHostLimit,
  getRedirectTarget,
  getUserAgent,
  serverErrorResult,
} from "./http";

/**
 * Result of fetching a page (URL without hash): either a final failure, or the status and the anchors of the page.
 */
export type FetchedPage =
  | { ok: true; status: number; redirectedTo?: string; getAnchors?: () => AnchorIndex }
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
 * Fetches a page with `GET`, also when only its status matters: some servers refuse `HEAD` or answer it differently
 * (support.google.com and chatgpt.com return 404 to HEAD and 200 to GET), and a failed HEAD needed a second request.
 * Limited per host, honours `Retry-After` on 429 (pauses the whole host), retries 502, 503 and 504. Never throws.
 */
const fetchPage = async (
  url: string,
  { needBody }: { needBody: boolean },
): Promise<FetchedPage> => {
  const headers = new Headers();
  const userAgent = getUserAgent(url);
  if (userAgent) {
    headers.set("User-Agent", userAgent);
  }

  try {
    // Limited per host (every redirect hop too), a 429 with Retry-After pauses the host and is retried,
    // unread bodies are cancelled (see `fetchWithHostLimit`).
    const response = await fetchWithHostLimit(url, { headers }, async (res) =>
      // Don't download the body when it's not needed (it might be a large file), it is cancelled instead.
      // An error page body is kept for the error detail.
      needBody || classifyStatus(res.status) !== "okay" ? res.text() : "",
    );

    const redirectedTo = getRedirectTarget(url, response.url);
    const withRedirect = (result: LinkCheckResult): LinkCheckResult =>
      redirectedTo ? { ...result, redirectedTo } : result;

    // Still rate limited after the retries (GitHub web rate limit makes you wait 60 seconds after 500 requests)
    const retryAfter = response.headers.get("Retry-After");
    if (response.status === 429 && retryAfter) {
      return {
        ok: false,
        result: withRedirect({
          ok: false,
          error: "unexpected error",
          status: response.status,
          // Raw header without a unit: it can be seconds or an HTTP date
          errorDetail: `\n Rate limited and gave up, Retry-After: ${retryAfter} for link ${url}`,
        }),
      };
    }

    // Still failing after the retries (see `fetchWithHostLimit`): the server is overloaded, not the link broken
    const statusClass = classifyStatus(response.status);
    if (statusClass === "server-error") {
      return {
        ok: false,
        result: withRedirect(serverErrorResult(response.status, response.statusText)),
      };
    }

    // 401 and 403 are broken here on purpose: they are re-checked with Playwright, which reports "could not check"
    if (statusClass !== "okay") {
      return {
        ok: false,
        result: withRedirect({
          ok: false,
          error: "broken link",
          status: response.status,
          errorDetail: `${response.statusText} ${response.data}`,
        }),
      };
    }

    return {
      ok: true,
      status: response.status,
      redirectedTo,
      getAnchors: needBody ? lazyAnchorIndex(response.data) : undefined,
    };
  } catch (error) {
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
   * @param pagesWithHash pages (URLs without hash) that are linked with a hash somewhere. Their body is read, also
   * for links without a hash, so the page is not fetched twice.
   */
  constructor(private readonly pagesWithHash: ReadonlySet<string> = new Set()) {}

  get(pageUrl: string, needBody: boolean): Promise<FetchedPage> {
    let page = this.pages.get(pageUrl);
    if (!page) {
      incrementMetric("uniquePagesFetched");
      page = fetchPage(pageUrl, { needBody: needBody || this.pagesWithHash.has(pageUrl) });
      this.pages.set(pageUrl, page);
    }
    return page;
  }
}

/** Result for a URL (possibly with a hash) based on its fetched page */
const getResultFromPage = (page: FetchedPage, url: string): LinkCheckResult => {
  if (!page.ok) {
    return page.result;
  }
  const { status, redirectedTo } = page;
  const redirect = redirectedTo ? { redirectedTo } : {};
  const hash = new URL(url).hash;
  if (!hash) {
    return { ok: true, status, ...redirect };
  }

  const note = getSpecialFragmentNote(hash.slice(1), url);
  if (note) {
    return { ok: true, status, note, ...redirect };
  }

  if (!page.getAnchors || !isHashInAnchorIndex(page.getAnchors(), hash)) {
    return { ok: false, status, error: "hash not found", ...redirect };
  }
  return { ok: true, status, ...redirect };
};

/**
 * Check a link with fetch, assuming page is server-side rendered
 * @param url link URL
 * @param pageCache share page fetches between links (links to the same page with different hashes fetch it once)
 * @returns LinkCheckResult. Expects a valid http(s) URL, `checkLinks` reports other URLs as invalid before getting here.
 */
export const checkLinkWithFetch = async (
  url: string,
  pageCache?: PageFetchCache,
): Promise<LinkCheckResult> => {
  const needBody = hasHash(url);
  const pageUrl = stripHash(url);
  const page = pageCache
    ? await pageCache.get(pageUrl, needBody)
    : await fetchPage(pageUrl, { needBody });
  return getResultFromPage(page, url);
};
