import * as cheerio from "cheerio";
import { chromium, Page } from "playwright";
import {
  CONCURRENCY_LIMIT,
  FORBIDDEN_STATUS_CODES,
  OKAY_STATUS_CODES,
  PLAYWRIGHT_CONCURRENCY_LIMIT,
  TASK_TIMEOUT,
  getRandomUserAgent,
  log,
  parallelProcess,
} from "./utils";
import { Link, LinkCheckResult, LinkWithResult } from "./types";
import { checkLinkWithGithubApi, isGithubCodeLineLink, isGithubUrl } from "./github/checkGithubLink";

type CheckLinksArgs = {
  links: Link[];
  verbose?: boolean;
  fetchConcurrencyLimit?: number;
};

export const checkLinks = async ({ links, verbose, fetchConcurrencyLimit = CONCURRENCY_LIMIT }: CheckLinksArgs) => {
  console.log(`\nChecking ${links.length} links...`);

  const linksToCheckWithPlaywright: Link[] = [];
  const resultMap = new Map<string, LinkCheckResult>();

  const { results: fetchResults, errors: fetchErrors } = await parallelProcess({
    items: links,
    concurrencyLimit: fetchConcurrencyLimit,
    processFn: async (link): Promise<LinkWithResult | null> => {
      let result: LinkCheckResult | null = null;
      const existingResult = resultMap.get(link.href);
      if (existingResult) {
        // Already checked, just use the result
        result = existingResult;
      } else {
        // New link, check it
        if (isGithubUrl(link.href)) {
          result = await checkLinkWithGithubApi(link.href);
        } else {
          result = await checkLinkWithFetch(link.href);
        }
        resultMap.set(link.href, result);
      }
      // Link not okay, add to Playwright queue
      if (result.ok === false) {
        linksToCheckWithPlaywright.push(link);
        return null;
      } else {
        return { ...link, result };
      }
    },
  });

  console.log(`Checking ${linksToCheckWithPlaywright.length} links with Playwright...`);

  const resultMapPlaywright = new Map<string, LinkCheckResult>();
  const { results: playwrightResults, errors: playwrightErrors } = await parallelProcess({
    items: linksToCheckWithPlaywright,
    concurrencyLimit: PLAYWRIGHT_CONCURRENCY_LIMIT,
    processFn: async (link) => {
      let result: LinkCheckResult | null = null;
      const existingResult = resultMapPlaywright.get(link.href);
      if (existingResult) {
        // Already checked, just use the result
        result = existingResult;
      } else {
        // New link, check it
        result = await checkLinkWithPlaywright(link.href);
        resultMapPlaywright.set(link.href, result);
      }
      return { ...link, result };
    },
  });

  const finalResults = [...fetchResults.filter((r) => r !== null), ...playwrightResults];
  const finalErrors = [...fetchErrors, ...playwrightErrors];

  console.log(`Checked ${finalResults.length} links.`);
  console.log(`Unexpected errors occurred for ${finalErrors.length} links`);
  log(finalErrors, verbose);
  return { results: finalResults, errors: finalErrors };
};

function shouldSpoofUserAgent(url: string) {
  // Android.com blocks you if you spoof the user agent
  if (url.includes("android.com")) {
    return false;
  }
  return true;
}

/**
 * Check a link with fetch, assuming page is server-side rendered
 * @param url link URL
 * @returns LinkCheckResult
 * @throws {Error} - network can fail or something
 */
export const checkLinkWithFetch = async (url: string, verbose = false): Promise<LinkCheckResult> => {
  const hash = new URL(url).hash;

  const headers = new Headers();
  if (shouldSpoofUserAgent(url)) {
    headers.set("User-Agent", getRandomUserAgent());
  }

  try {
    const response = await fetch(url, {
      method: hash ? "GET" : "HEAD",
      redirect: "follow",
      headers,
    });

    // GitHub web rate limit makes you wait 60 seconds after 500 requests
    const retryAfter = response.headers.get("Retry-After");
    if (response.status === 429 && retryAfter) {
      const retryAfterSeconds = parseInt(retryAfter);
      const retryAfterMs = retryAfterSeconds * 1000;
      if (retryAfterMs < TASK_TIMEOUT) {
        console.log(`Rate limited, retrying after ${retryAfter} seconds...`);
        await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
        return await checkLinkWithFetch(url, verbose);
      } else {
        return {
          ok: false,
          error: "unexpected error",
          status: response.status,
          errorDetail: `\n Rate limited and gave up, retry-after: ${retryAfterSeconds} seconds for link ${url}`,
        };
      }
    }

    if (OKAY_STATUS_CODES.includes(response.status) === false) {
      return {
        ok: false,
        error: "broken link",
        status: response.status,
        errorDetail: `${response.statusText} ${await response.text()}`,
      };
    }

    if (!hash) {
      log(`OK`, verbose);
      return { ok: true, status: response.status };
    }

    if (hash === "#/") {
      return { ok: true, status: response.status, note: "Accidental hash" };
    }

    if (hash.includes(":~:")) {
      /**
       * The link includes a [Text Fragment](https://developer.mozilla.org/en-US/docs/Web/Text_fragments)
       * Checking this properly is not trivial, let's ignore them for now
       **/
      return { ok: true, status: response.status, note: "Text Fragment" };
    }

    var $ = cheerio.load(await response.text());

    const selectors = [
      // Normal `id="hash"` selector
      hash,
      // Some websites put the hash into the `href="#hash"` attribute instead of `id="hash"`
      `[href=${hash}]`,
      `[href=${hash.toLowerCase()}]`,
      // GitHub uses `data-line-number` attribute to handle line links like `#L12` and `#L12-L15` (check just the first one for simplicity)
      // Note: This no longer works since GitHub seems to have switched to client-side rendering 🤦 Playwright fallback still works
      // Keeping it here just in case GitHub comes to their senses and switches back to server-side rendering
      isGithubCodeLineLink(url) && `[data-line-number=${hash.split("-")[0].slice(2)}]`,
    ];
    var element = $(selectors.join(", ")).first();
    if (element.length === 0) {
      return {
        ok: false,
        status: response.status,
        error: "hash not found",
      };
    }

    log(`OK`, verbose);
    return { ok: true, status: response.status };
  } catch (error) {
    log(`Something went wrong: ${error}`, verbose);
    return {
      ok: false,
      error: "broken link",
      errorDetail: String(error),
    };
  }
};

async function isHashPresentPlaywright(page: Page, hash: string, url: string, timeout = 3000) {
  const selectors = [
    `[id="${hash}"]`,
    `[href="#${hash}"]`,
    `[href="#${hash.toLowerCase()}"]`,
    // GitHub uses `data-line-number` attribute to handle line links like `#L12` and `#L12-L15` (check just the first one for simplicity)
    isGithubCodeLineLink(url) && `[data-line-number="${hash.split("-")[0].slice(1)}"]`,
  ];

  const locator = page.locator(selectors.join(", ")).first();

  try {
    // Wait for the locator to be visible with a custom timeout
    await locator.waitFor({ state: "visible", timeout: timeout });
    return true;
  } catch (error) {
    // If the timeout is reached, return false instead of throwing an error
    if (error instanceof Error && error.name === "TimeoutError") {
      return false;
    }
    // Re-throw any other errors
    throw error;
  }
}

export async function checkLinkWithPlaywright(url: string, verbose = false, headless = true): Promise<LinkCheckResult> {
  const browser = await chromium.launch({
    headless,
    // Potentially helps avoid some bot detection checks
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    userAgent: shouldSpoofUserAgent(url) ? getRandomUserAgent() : undefined,
  });
  const page = await context.newPage();

  try {
    // Navigate to the URL
    const response = await page.goto(url);

    log(`Navigation response: ${response?.status()}`, verbose);
    if (response && FORBIDDEN_STATUS_CODES.includes(response.status())) {
      return {
        ok: false,
        error: "could not check",
        status: response.status(),
        errorDetail: `${response.statusText()} ${await response.text()}`,
      };
    }

    // Check if the current URL matches the given URL
    if (!response || !OKAY_STATUS_CODES.includes(response.status())) {
      return {
        ok: false,
        error: "broken link",
        status: response?.status() ?? 0,
      };
    }

    const hash = new URL(url).hash.replace("#", "");

    if (hash === "/") {
      return { ok: true, status: response.status(), note: "Accidental hash" };
    }

    if (hash.includes(":~:")) {
      return { ok: true, status: response.status(), note: "Text Fragment" };
    }

    if (hash && !(await isHashPresentPlaywright(page, hash, url))) {
      log(`Hash not found`, verbose);
      return {
        ok: false,
        status: response.status(),
        error: "hash not found",
      };
    }

    log(`OK`, verbose);
    return { ok: true, status: response.status() };
  } catch (error) {
    return {
      ok: false,
      error: "broken link",
      errorDetail: String(error),
    };
  } finally {
    if (headless) {
      await browser.close();
    }
  }
}
