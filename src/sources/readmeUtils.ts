import { parseLinksFromPage } from "../page";
import { CONCURRENCY_LIMIT, parallelProcess, progressBar } from "../utils";
import { Link } from "../types";
import { checkLinks } from "../link";
import { getJSONReport, saveReport } from "../report/report";

require("dotenv").config();

const callReadmeApi = async <T = any>(url: string) => {
  const headers = { authorization: `Basic ${process.env.README_API_KEY}` };
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: headers,
    });

    if (!response.ok) {
      throw new Error(`HTTP error for ${url}! status: ${response.status}`);
    }
    return response.json() as T;
  } catch (error) {
    throw new Error(`Parsing error for ${url} : ${error}`);
  }
};

async function fetchCategoriesSlugs() {
  console.log("Fetching categories from Readme...");
  const categories = await callReadmeApi("https://dash.readme.com/api/v1/categories?perPage=100");
  return categories.map((category: any) => category.slug);
}

async function fetchCategoryPages(categorySlug: string): Promise<PageItem[]> {
  return callReadmeApi<PageItem[]>(`https://dash.readme.com/api/v1/categories/${categorySlug}/docs`);
}

async function fetchPage(slug: string) {
  return callReadmeApi<PageData>(`https://dash.readme.com/api/v1/docs/${slug}`);
}

type PageItem = {
  slug: string;
  hidden: boolean;
  children: PageItem[];
};

type PageData = {
  slug: string;
  body_html: string;
  type: "basic" | "link";
};

const flattenNestedPages = (pages: PageItem[]): PageItem[] => {
  return [...pages.map((page) => page), ...pages.flatMap((page) => flattenNestedPages(page.children))];
};

const getPageSlugsFromCategories = async (categorySlugs: string[], concurrencyLimit = CONCURRENCY_LIMIT) => {
  console.log(`Fetching pages slugs from ${categorySlugs.length} categories...`);
  const { results, errors } = await parallelProcess(
    categorySlugs,
    async (categorySlug) => {
      const categoryPages = await fetchCategoryPages(categorySlug);
      const slugs = flattenNestedPages(categoryPages)
        .filter((page) => !page.hidden)
        .map((page) => page.slug);
      return slugs;
    },
    concurrencyLimit
  );

  if (errors.length > 0) {
    console.error(`Errors fetching page slugs: ${errors.length}`, errors.toString());
  }
  return results.flat();
};

const extractLinksFromPages = async (pageSlugs: string[], concurrencyLimit = CONCURRENCY_LIMIT): Promise<Link[]> => {
  console.log(`Extracting links from ${pageSlugs.length} pages...`);
  const { results, errors } = await parallelProcess(
    pageSlugs,
    async (pageSlug) => {
      const page = await fetchPage(pageSlug);
      // You might get a public "Link"" page with some irrelevant content, ignore it
      if (page.type !== "basic") {
        return [];
      }
      const links = await parseLinksFromPage("https://dev.fingerprint.com/docs/" + page.slug, page.body_html);
      return links;
    },
    concurrencyLimit
  );

  if (errors.length > 0) {
    console.error(`Errors fetching pages and extracting links: ${errors.length}`, errors.toString());
  }
  return results.flat();
};

export const checkReadmeDocs = async (siteName: string) => {
  const startTime = performance.now();
  const concurrencyLimit = 10;

  const categoriesSlugs = await fetchCategoriesSlugs();
  console.log(`Fetched ${categoriesSlugs.length} categories.\n`);

  const pagesSlugs = await getPageSlugsFromCategories(categoriesSlugs, concurrencyLimit);
  console.log(`Fetched ${pagesSlugs.length} pages.\n`);

  const links = await extractLinksFromPages(pagesSlugs, concurrencyLimit);
  console.log(`Extracted ${links.length} links.\n`);

  const { results, errors } = await checkLinks({ links, concurrencyLimit });

  const report = getJSONReport({ links: results, errors, siteName });

  // For easier report generation debugging
  //  const report = JSON.parse(readFileSync("./results/brokenLinks-dev.fingerprint.com.json").toString());
  saveReport(report);
  console.log(report.summary);

  console.log(`Finished in ${(performance.now() - startTime) / 1000} seconds.`);
  return report;
};
