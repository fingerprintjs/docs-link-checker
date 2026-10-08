/**
 * `site` command: checks the links on all pages of a website (from its sitemap).
 * STUB: `checkWebsite` is implemented by the PIPELINE group.
 */
import { Effect } from "effect";
import type { RunServices } from "./app";
import type { FetchError, HttpStatusError, TooManyRedirects } from "./errors";
import type { Link, LinkWithResult } from "./types";

/** Link filter keeping only links starting with one of the prefixes (`site --include`) */
export const createPrefixFilter =
  (prefixes: ReadonlyArray<string>) =>
  (link: Link): boolean =>
    prefixes.some((prefix) => link.href.startsWith(prefix));

export const checkWebsite: (args: {
  readonly websiteUrl: string;
  readonly linkFilter?: (link: Link) => boolean;
  readonly sampleRate: number;
}) => Effect.Effect<
  LinkWithResult[],
  FetchError | TooManyRedirects | HttpStatusError,
  RunServices
> = () => Effect.die("not implemented");
