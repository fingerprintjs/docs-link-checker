/**
 * Page URLs of a website from its sitemap(s).
 * STUB: `getWebsitePages` is implemented by the PIPELINE group.
 */
import { Effect } from "effect";
import type { FetchError, HttpStatusError, TooManyRedirects } from "./errors";
import type { Fetch } from "./http";
import type { HostLimiter } from "./limiter";
import type { Metrics } from "./metrics";

// How deep nested sitemap indexes are followed (sitemap index -> sitemap index -> ... -> sitemap)
export const MAX_SITEMAP_DEPTH = 3;

export const getWebsitePages: (
  url: string,
) => Effect.Effect<
  string[],
  FetchError | TooManyRedirects | HttpStatusError,
  Fetch | HostLimiter | Metrics
> = () => Effect.die("not implemented");
