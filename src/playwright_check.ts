/**
 * Checks the hashes of URLs of one page in the DOM with Playwright.
 * STUB: signature is final, implemented by the BROWSER group.
 */
import { Effect } from "effect";
import type { Browser } from "./browser";
import type { BrowserLaunchError, PlaywrightError } from "./errors";
import type { HostLimiter } from "./limiter";
import type { Metrics } from "./metrics";
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

export const checkUrlsOnPageWithPlaywright: (
  urls: ReadonlyArray<string>,
) => Effect.Effect<
  Map<string, LinkCheckResult>,
  BrowserLaunchError | PlaywrightError,
  Browser | HostLimiter | Metrics
> = () => Effect.die("not implemented");
