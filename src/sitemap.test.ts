import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getWebsitePages, MAX_SITEMAP_DEPTH } from "./sitemap";

const sitemapIndex = (locs: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locs.map((loc) => `  <sitemap><loc>${loc}</loc></sitemap>`).join("\n")}
</sitemapindex>`;

const urlSet = (locs: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locs.map((loc) => `  <url><loc>${loc}</loc></url>`).join("\n")}
</urlset>`;

const stubSitemaps = (files: Record<string, string>) => {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    return url in files
      ? new Response(files[url], { status: 200 })
      : new Response("", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const SITE = "https://example.com";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getWebsitePages()", () => {
  it("reads pages from a plain sitemap.xml", async () => {
    stubSitemaps({ [`${SITE}/sitemap.xml`]: urlSet([`${SITE}/a`, `${SITE}/b`]) });
    expect(await getWebsitePages(SITE)).toEqual([`${SITE}/a`, `${SITE}/b`]);
  });

  it("fails loudly when a nested sitemap cannot be fetched", async () => {
    stubSitemaps({ [`${SITE}/sitemap.xml`]: sitemapIndex([`${SITE}/sitemap-missing.xml`]) });
    await expect(getWebsitePages(SITE)).rejects.toThrow(
      `Could not fetch sitemap ${SITE}/sitemap-missing.xml: status 404`,
    );
  });

  it("follows nested sitemap indexes recursively and dedupes pages and sitemaps", async () => {
    const fetchMock = stubSitemaps({
      [`${SITE}/sitemap.xml`]: sitemapIndex([
        `${SITE}/sitemap-docs.xml`,
        `${SITE}/sitemap-nested-index.xml`,
      ]),
      [`${SITE}/sitemap-nested-index.xml`]: sitemapIndex([
        `${SITE}/sitemap-blog.xml`,
        // Listed twice in the same index
        `${SITE}/sitemap-blog.xml`,
        // Already listed in the parent index
        `${SITE}/sitemap-docs.xml`,
        // Cycle
        `${SITE}/sitemap.xml`,
      ]),
      [`${SITE}/sitemap-docs.xml`]: urlSet([`${SITE}/docs/1`, `${SITE}/docs/2`]),
      [`${SITE}/sitemap-blog.xml`]: urlSet([`${SITE}/blog/1`, `${SITE}/docs/1`]),
    });

    const pages = await getWebsitePages(SITE);

    expect(pages.toSorted()).toEqual([`${SITE}/blog/1`, `${SITE}/docs/1`, `${SITE}/docs/2`]);
    const fetchedUrls = fetchMock.mock.calls.map(([url]) => String(url));
    // Every sitemap is fetched once
    expect(fetchedUrls.filter((url) => url === `${SITE}/sitemap-docs.xml`)).toHaveLength(1);
    expect(fetchedUrls.filter((url) => url === `${SITE}/sitemap.xml`)).toHaveLength(1);
    expect(fetchedUrls.filter((url) => url === `${SITE}/sitemap-blog.xml`)).toHaveLength(1);
  });

  it("falls back to sitemap-index.xml", async () => {
    stubSitemaps({
      [`${SITE}/sitemap-index.xml`]: sitemapIndex([`${SITE}/sitemap-0.xml`]),
      [`${SITE}/sitemap-0.xml`]: urlSet([`${SITE}/a`]),
    });
    expect(await getWebsitePages(SITE)).toEqual([`${SITE}/a`]);
  });
});

describe("getWebsitePages() without sitemap", () => {
  it("returns no pages and logs an error", async () => {
    stubSitemaps({});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await getWebsitePages(SITE)).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("getWebsitePages() limits", () => {
  it(`stops following sitemap indexes nested deeper than ${MAX_SITEMAP_DEPTH}`, async () => {
    // sitemap.xml -> index-1 -> ... -> index-10 -> pages
    const files: Record<string, string> = {};
    files[`${SITE}/sitemap.xml`] = sitemapIndex([`${SITE}/index-1.xml`]);
    for (let i = 1; i < 10; i++) {
      files[`${SITE}/index-${i}.xml`] = sitemapIndex([`${SITE}/index-${i + 1}.xml`]);
    }
    files[`${SITE}/index-10.xml`] = urlSet([`${SITE}/deep`]);
    const fetchMock = stubSitemaps(files);

    const pages = await getWebsitePages(SITE);

    expect(pages).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_SITEMAP_DEPTH + 1);
  });
});
