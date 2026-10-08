import * as cheerio from "cheerio";
import { Data, Effect } from "effect";
import { fetchWithHostLimit, readText, USER_AGENT } from "./http";
import type { Link } from "./types";
import { processInParallel } from "./utils";

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

export function filterOutIrrelevantLinks(links: Link[]): Link[] {
  return links.filter(
    (link) =>
      isHttpUrl(link.href) &&
      !isHostToFilterOut(link.href) &&
      !patternsToFilterOut.some((pattern) => pattern.test(link.href)),
  );
}

/** A page answered with a status other than 2xx */
class PageStatusError extends Data.TaggedError("PageStatusError")<{
  readonly url: string;
  readonly status: number;
}> {
  override get message() {
    return `Could not fetch ${this.url}, status: ${this.status}`;
  }
}

/**
 * Parses links from a single page. Relative links are resolved against `pageUrl` (the sitemap URL), not the redirected URL.
 * Fails if the page can't be fetched, so it shows up in the extraction errors instead of silently having no links.
 */
const parseLinksFromPage = (pageUrl: string) =>
  Effect.gen(function* () {
    // Limited per host (like link checks), with a request timeout. A 429 with Retry-After pauses the host and is retried.
    const response = yield* fetchWithHostLimit(
      pageUrl,
      { headers: { "User-Agent": USER_AGENT } },
      (res) => (res.ok ? readText(res) : Effect.succeed("")),
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* new PageStatusError({ url: pageUrl, status: response.status });
    }

    // Parse links from page HTML
    const $ = cheerio.load(response.data, { baseURI: pageUrl });
    const result: Link[] = [];
    $("a").each((_index, value) => {
      const href = value.attribs.href;
      if (href) {
        // Resolves both absolute and relative links (relative to pageUrl)
        result.push({ href: new URL(href, pageUrl).href, text: $(value).text(), page: pageUrl });
      }
    });

    return filterOutIrrelevantLinks(result);
  });

/**
 * Parses links from multiple pages. Pages that fail are returned in `errors`, the others are still processed.
 * @param pages
 * @param linkFilter Filter function to apply to links
 */
export const getLinksFromPages = ({
  pages,
  linkFilter,
}: {
  pages: string[];
  linkFilter?: (link: Link) => boolean;
}) =>
  Effect.gen(function* () {
    console.log(`Retrieving links from ${pages.length} pages...`);
    // Parse links from pages
    const { results, errors } = yield* processInParallel({
      items: pages,
      processFn: parseLinksFromPage,
    });

    // Flatten and filter results if a link filter is provided
    const flatResults = results.flat();
    console.log(`Extracted ${flatResults.length} links.`);
    const links = linkFilter ? flatResults.filter(linkFilter) : flatResults;
    if (linkFilter) {
      console.log(
        `Filtered away ${flatResults.length - links.length} links using the provided links filter. Continuing with ${
          links.length
        } links...`,
      );
    }

    if (errors.length > 0) {
      console.log(`Retrieving links failed for ${errors.length} pages.`);
    }

    return { links, errors };
  });
