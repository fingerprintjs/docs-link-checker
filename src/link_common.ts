import type { DestinationNotAllowedError } from "./destination";
import type { LinkCheckResult } from "./types";

/** Result for a link to a private or local address: never requested, not counted as broken */
export const getBlockedDestinationResult = (
  error: DestinationNotAllowedError,
): LinkCheckResult => ({
  ok: false,
  error: "could not check",
  errorDetail: error.message,
  destinationBlocked: true,
});

/** The URL without its hash (`https://example.com/page#section` -> `https://example.com/page`) */
export const stripHash = (href: string): string => {
  try {
    const url = new URL(href);
    url.hash = "";
    return url.href;
  } catch {
    return href;
  }
};

/** The URL has a non-empty hash */
export const hasHash = (href: string): boolean => {
  try {
    return new URL(href).hash !== "";
  } catch {
    return false;
  }
};

/** Android.com blocks you if you spoof the user agent */
export const shouldSpoofUserAgent = (url: string): boolean => !url.includes("android.com");

// Google Help Center hosts, their `#zippy=` fragments expand accordion sections
const GOOGLE_HELP_HOSTS = new Set(["support.google.com"]);

/**
 * Fragments that are not element ids, so they are accepted without looking for an anchor
 * @param fragment the URL hash without `#`
 * @param url the full URL (some fragments are only special on some hosts)
 * @returns a note for the report, or `undefined` for a regular anchor
 */
export const getSpecialFragmentNote = (fragment: string, url: string): string | undefined => {
  if (fragment === "/") {
    return "Accidental hash";
  }
  if (fragment.includes(":~:")) {
    /**
     * The link includes a [Text Fragment](https://developer.mozilla.org/en-US/docs/Web/Text_fragments)
     * Checking this properly is not trivial, let's ignore them for now
     **/
    return "Text Fragment";
  }
  if (fragment.startsWith("zippy=") && GOOGLE_HELP_HOSTS.has(new URL(url).hostname)) {
    // Google Help Center: `#zippy=,section` expands accordion sections, there is no element with that id
    return "Google Help accordion state";
  }
  return undefined;
};
