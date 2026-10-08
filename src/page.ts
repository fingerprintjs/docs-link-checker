/**
 * Links of website pages and the filter of links that are not worth checking.
 * STUB: `getLinksFromPages` is implemented by the PIPELINE group.
 */
import { Effect } from "effect";
import type { Fetch } from "./http";
import type { HostLimiter } from "./limiter";
import type { Metrics } from "./metrics";
import type { Link } from "./types";
import type { ItemError } from "./utils";

// Only http(s) links can be checked, skip `tel:`, `javascript:`, `data:` and other schemes
const isHttpUrl = (href: string) => {
  try {
    return ["http:", "https:"].includes(new URL(href).protocol);
  } catch {
    // Unparsable URLs are kept, they are reported as broken links
    return true;
  }
};

// Compared with the parsed host, a regex on the raw URL also matches `portal.azure.com.example.com`
const hostsToFilterOut = [
  // Gives 500 and redirects to the native app store
  "apps.apple.com",
  // Requires login, also regional subdomains (`eu-west-1.console.aws.amazon.com`)
  "console.aws.amazon.com",
  // Requires login
  "portal.azure.com",
  "dash.cloudflare.com",
];

const patternsToFilterOut = [
  // Not a real page, tied to the path and not to the host
  /cdn-cgi\/l\/email-protection/,
  // Readme sends the internal link syntax from the server only updates it with JavaScript client-side 🤦
  /^doc:/,
  /^ref:/,
  // And other readme bugs
  /^https:\/\/dev\.fingerprint\.com\/recipes/,
  /^https:\/\/dev\.fingerprint\.com\/discuss/,
];

const isHostToFilterOut = (href: string) => {
  const { hostname } = URL.canParse(href) ? new URL(href) : { hostname: "" };
  return (
    hostname === "localhost" ||
    hostsToFilterOut.some((host) => hostname === host || hostname.endsWith(`.${host}`))
  );
};

export const filterOutIrrelevantLinks = (links: ReadonlyArray<Link>): Link[] => {
  return links.filter(
    (link) =>
      isHttpUrl(link.href) &&
      !isHostToFilterOut(link.href) &&
      !patternsToFilterOut.some((pattern) => pattern.test(link.href)),
  );
};

export const getLinksFromPages: (args: {
  readonly pages: ReadonlyArray<string>;
  readonly linkFilter?: (link: Link) => boolean;
}) => Effect.Effect<
  { links: Link[]; errors: ItemError<string>[] },
  never,
  Fetch | HostLimiter | Metrics
> = () => Effect.die("not implemented");
