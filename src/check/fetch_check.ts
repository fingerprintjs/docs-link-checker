/**
 * Link checks with plain `fetch`, for server-side rendered pages: fetches each page once (see `PageFetchCache`) and
 * looks for hashes in its HTML. What the response means is decided by `judgePage` (see `verdict.ts`).
 */
import { incrementMetric } from "../run";
import type { LinkCheckResult } from "../types";
import {
  type AnchorIndex,
  buildAnchorIndex,
  hasHash,
  isHashInAnchorIndex,
  stripHash,
} from "./hash";
import { fetchWithHostLimit, getRedirectTarget, getUserAgent } from "./http";
import { judgeLink, judgePage, type PageVerdict } from "./verdict";

/** A fetched page (URL without hash), with its anchors when its body was needed */
type FetchedPage = {
  verdict: PageVerdict;
  redirectedTo?: string;
  getAnchors?: () => AnchorIndex;
};

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
    // Limited per host (every redirect hop too), 429 and server errors are retried, unread bodies are cancelled
    // (see `fetchWithHostLimit`)
    const response = await fetchWithHostLimit(url, { headers }, async (res) => {
      const verdict = await judgePage("fetch", {
        type: "response",
        url,
        status: res.status,
        statusText: res.statusText,
        retryAfter: res.headers.get("Retry-After"),
        readBody: () => res.text(),
      });
      // Don't download the body when it's not needed (it might be a large file), it is cancelled instead
      const html = verdict.ok && needBody ? await res.text() : undefined;
      return { verdict, html };
    });
    const { verdict, html } = response.data;
    return {
      verdict,
      redirectedTo: getRedirectTarget(url, response.url),
      getAnchors: html === undefined ? undefined : lazyAnchorIndex(html),
    };
  } catch (error) {
    return { verdict: await judgePage("fetch", { type: "error", error }) };
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
  return judgeLink(url, page.verdict, {
    redirectedTo: page.redirectedTo,
    isHashPresent: (fragment) =>
      page.getAnchors !== undefined && isHashInAnchorIndex(page.getAnchors(), fragment),
  });
};
