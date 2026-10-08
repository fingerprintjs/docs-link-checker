// Skeleton: the titles of main's tests, to port with the new design (STEP 2, PIPELINE group).
import { describe, it } from "vitest";

describe("getWebsitePages()", () => {
  it.todo("reads pages from a plain sitemap.xml");
  it.todo("fails loudly when a nested sitemap cannot be fetched");
  it.todo("follows nested sitemap indexes recursively and dedupes pages and sitemaps");
  it.todo("falls back to sitemap-index.xml");
});
describe("getWebsitePages() without sitemap", () => {
  it.todo("returns no pages and logs an error");
});
describe("getWebsitePages() limits", () => {
  it.todo("stops following sitemap indexes nested deeper than MAX_SITEMAP_DEPTH");
});
