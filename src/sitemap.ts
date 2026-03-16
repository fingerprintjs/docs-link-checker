import * as cheerio from "cheerio";
import { getRandomUserAgent, log } from "./utils";
import { chromium } from "playwright";

async function fetchTextWithPlaywright(url: string) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  try {
    const context = await browser.newContext({
      userAgent: getRandomUserAgent(),
    });
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: "networkidle" });
    if (!response?.ok()) {
      throw new Error(`Could not fetch ${url} with Playwright, status: ${response?.status()}`);
    }
    return (await page.textContent("body")) ?? "";
  } finally {
    await browser.close();
  }
}

async function fetchTextWithFallback(url: string) {
  const response = await fetch(url, {
    headers: { "User-Agent": getRandomUserAgent() },
  });
  const text = await response.text();

  if (response.ok && !text.includes("Vercel Security Checkpoint")) {
    return text;
  }

  return await fetchTextWithPlaywright(url);
}

function getSitemapsFromRobotsTxt(robotsTxt: string) {
  return robotsTxt
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.toLowerCase().startsWith("sitemap:"))
    .map((line) => line.slice("sitemap:".length).trim())
    .filter(Boolean);
}

/**
 * Retrieves all the pages from a website by fetching the sitemap and parsing it.
 *
 * @param {string} url - The URL of the website.
 * @param {boolean} [verbose=false] - Whether to log the progress of the function.
 * @return {Promise<string[]>} - A promise that resolves to an array of page URLs.
 */
export const getWebsitePages = async (url: string, verbose = false) => {
  const sitemaps = await getWebsiteSitemaps(url, verbose);
  const pages = await(
    await Promise.all(sitemaps.map(async (sitemap) => await getPagesFromSitemap(sitemap)))
  ).flat();

  return pages;
};

/**
 * Retrieves the all sitemaps from the websites sitemap-index or a single sitemap, whatever the website has.
 *
 * @param {string} url - The URL of the website.
 * @param {boolean} [verbose=false] - Whether to log the progress.
 * @return {Promise<string[]>} - A promise that resolves to an array of sitemap URLs.
 */
export const getWebsiteSitemaps = async (url: string, verbose = false): Promise<string[]> => {
  const sitemapResponse = await fetch(`${url}/sitemap.xml`, {
    headers: { "User-Agent": getRandomUserAgent() },
  });
  const sitemapExists = sitemapResponse.ok;
  if (sitemapExists) {
    log("Sitemap.xml exists, parsing pages from it", verbose);
    return [`${url}/sitemap.xml`];
  }

  const robotsTxt = await fetchTextWithFallback(`${url}/robots.txt`);
  const sitemapUrlsFromRobotsTxt = getSitemapsFromRobotsTxt(robotsTxt);
  if (sitemapUrlsFromRobotsTxt.length > 0) {
    log(`Retrieved ${sitemapUrlsFromRobotsTxt.length} sitemap references from robots.txt`, verbose);
    return sitemapUrlsFromRobotsTxt;
  }

  const sitemapIndex = await fetchTextWithFallback(`${url}/sitemap-index.xml`);
  const sitemaps: string[] = getSitemapsFromSitemapIndex(sitemapIndex);
  if (sitemaps.length === 0) {
    console.error("No sitemap.xml, sitemap-index.xml, or robots.txt sitemap entries found");
    return [];
  }
  log(`Retrieved ${sitemaps.length} sitemaps from sitemap-index.xml`, verbose);
  return sitemaps;
};

/**
 * Retrieves an array of sitemap URLs from a sitemap index XML file.
 *
 * @param {string} sitemapIndexUrl - The URL of the sitemap index XML file.
 * @return {string[]} An array of sitemap URLs.
 */
function getSitemapsFromSitemapIndex(sitemapIndexUrl: string) {
  const $ = cheerio.load(sitemapIndexUrl, { xmlMode: true });
  const sitemaps: string[] = [];
  $("sitemap").each((_, sitemapElem) => {
    const location = $(sitemapElem).find("loc").text();
    sitemaps.push(location);
  });
  return sitemaps;
}

/**
 * Retrieves pages from a sitemap URL and logs the number of pages retrieved.
 *
 * @param {string} sitemapUrl - The URL of the sitemap.
 * @param {boolean} [verbose=false] - Whether to log the progress.
 * @return {string[]} An array of page URLs retrieved from the sitemap.
 */
export const getPagesFromSitemap = async (sitemapUrl: string, verbose = false): Promise<string[]> => {
  const response = await fetchTextWithFallback(sitemapUrl);
  const $ = cheerio.load(response, { xmlMode: true });
  const pages: string[] = [];
  $("url").each((_, urlElem) => {
    const location = $(urlElem).find("loc").text();
    pages.push(location);
  });

  if (pages.length === 0) {
    const nestedSitemaps = getSitemapsFromSitemapIndex(response);
    if (nestedSitemaps.length > 0) {
      console.log(`Retrieved ${nestedSitemaps.length} nested sitemaps from ${sitemapUrl} sitemap index.`);
      const nestedPages: string[] = await (
        await Promise.all(nestedSitemaps.map(async (nestedSitemap) => await getPagesFromSitemap(nestedSitemap, verbose)))
      ).flat();
      log(nestedPages, verbose);
      return nestedPages;
    }
  }

  console.log(`Retrieved ${pages.length} pages from ${sitemapUrl} sitemap.`);
  log(pages, verbose);
  return pages;
};
