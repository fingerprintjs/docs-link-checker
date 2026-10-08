/**
 * Link check with plain `fetch`: one fetch per page (`PageCache`), hashes checked against the HTML anchors.
 * STUB: implemented by the PIPELINE group.
 */
import { type Cache, Effect } from "effect";
import type { AnchorIndex } from "./hash";
import type { Fetch } from "./http";
import type { HostLimiter } from "./limiter";
import type { Metrics } from "./metrics";
import type { LinkCheckResult } from "./types";

/** Result of fetching a page (URL without hash): a final failure, or the status and the anchors of the page */
export type FetchedPage =
  | { readonly ok: true; readonly status: number; readonly getAnchors?: () => AnchorIndex }
  | { readonly ok: false; readonly result: LinkCheckResult };

/** Key: page URL without hash */
export type PageCache = Cache.Cache<string, FetchedPage>;

/**
 * `Cache.make` with infinite TTL, lookup = fetch the page (body only if a link to it has a hash),
 * counts `uniquePagesFetched` on a miss.
 */
export const makePageCache: (
  pagesWithHash: ReadonlySet<string>,
) => Effect.Effect<PageCache, never, Fetch | HostLimiter | Metrics> = () =>
  Effect.die("not implemented");

/** Never fails: network errors and bad statuses are results. Without a cache each call fetches. */
export const checkLinkWithFetch: (
  url: string,
  pageCache?: PageCache,
) => Effect.Effect<LinkCheckResult, never, Fetch | HostLimiter | Metrics> = () =>
  Effect.die("not implemented");
