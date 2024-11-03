import * as cheerio from "cheerio";
import { chromium, Page } from "playwright";
import { BROWSER_USER_AGENT, FORBIDDEN_STATUS_CODES, OKAY_STATUS_CODES, log, parallelProcess } from "./utils";
import { Link, LinkCheckResult, LinkWithResult } from "./types";

type CheckLinksArgs = {
  links: Link[];
  verbose?: boolean;
  concurrencyLimit?: number;
};

export const checkLinks = async ({ links, verbose, concurrencyLimit }: CheckLinksArgs) => {
  console.log(`\nChecking ${links.length} links...`);
  const resultMap = new Map<string, LinkCheckResult>();

  const { results, errors } = await parallelProcess(
    links,
    async (link) => {
      const existingResult = resultMap.get(link.href);
      if (existingResult) {
        // Already checked, just use the result
        (link as LinkWithResult).result = existingResult;
      } else {
        // New link, check it
        const newResult = await checkLink(link.href);
        resultMap.set(link.href, newResult);
        (link as LinkWithResult).result = newResult;
      }
      return link as LinkWithResult;
    },
    concurrencyLimit
  );

  console.log(`Checked ${results.length} links.`);
  console.log(`Unexpected errors ocurred for ${errors.length} links`);
  log(errors, verbose);
  return { results, errors };
};

function getUserAgent(url: string) {
  return BROWSER_USER_AGENT;
}

/**
 *
 * @param url link URL
 * @returns LinkCheckResult
 * @throws {Error} - network can fail or something
 */
export const checkLink = async (url: string, verbose = false): Promise<LinkCheckResult> => {
  const hash = new URL(url).hash;
  try {
    const response = await fetch(url, {
      method: hash ? "GET" : "HEAD",
      redirect: "follow",
      headers: {
        "User-Agent": getUserAgent(url),
      },
    });

    if (OKAY_STATUS_CODES.includes(response.status) === false) {
      log(`Responded with ${response.status}, ${response.statusText}, trying with Playwright`, verbose);
      return await checkLinkWithPlaywright(url, verbose);
    }

    if (!hash) {
      log(`OK`, verbose);
      return { ok: true, status: response.status };
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
      isGithubCodeLineLink(url) && `[data-line-number=${hash.split("-")[0].slice(2)}]`,
    ];
    var element = $(selectors.join(", ")).first();
    if (element.length === 0) {
      log(`Hash ${hash} not found at first, trying with Playwright`, verbose);
      return await checkLinkWithPlaywright(url, verbose);
    }

    log(`OK`, verbose);
    return { ok: true, status: response.status };
  } catch (error) {
    log(`Something went wrong: ${error}`, verbose);
    log("Checking with Playwright", verbose);
    return await checkLinkWithPlaywright(url, verbose);
  }
};

async function isHashPresent(page: Page, hash: string, timeout = 3000) {
  const locator = page.locator(`[id="${hash}"], [href="#${hash}"], [href="#${hash.toLowerCase()}"]`).first();

  try {
    // Wait for the locator to be visible with a custom timeout
    await locator.waitFor({ state: "visible", timeout: timeout });
    return true;
  } catch (error) {
    // If the timeout is reached, return false instead of throwing an error
    if (error.name === "TimeoutError") {
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
    userAgent: getUserAgent(url),
  });
  const page = await context.newPage();

  try {
    // Navigate to the URL
    const response = await Promise.race([
      page.goto(url),
      page.waitForResponse((response) => response.url() === url && response.status() > 99),
    ]);

    log(`Navigation response: ${response?.status()}`, verbose);
    if (response && FORBIDDEN_STATUS_CODES.includes(response.status())) {
      return {
        ok: false,
        error: "could not check",
        errorDetail: `Status ${response.status()}, ${response.statusText()}`,
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

    if (hash.includes(":~:")) {
      return { ok: true, status: response.status(), note: "Text Fragment" };
    }

    if (hash && !(await isHashPresent(page, hash))) {
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
      errorDetail: error.toString(),
    };
  } finally {
    if (headless) {
      await browser.close();
    }
  }
}

export const isGithubCodeLineLink = (href: string) => {
  const url = new URL(href);
  return url.host === "github.com" && url.pathname.includes("/blob/") && /^#L\d+(-L\d+)?$/.test(url.hash);
};