import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostLimiter } from "./limiter";
import { setHostLimiter } from "./run";
import {
  getPagesFromSitemap,
  getWebsitePages,
  MAX_SITEMAP_DEPTH,
  SITEMAP_FETCH_CONCURRENCY,
} from "./sitemap";

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

  it("does not read the body of a failed sitemap response", async () => {
    let failedBodyCancelled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input) === `${SITE}/sitemap.xml`) {
          return new Response(sitemapIndex([`${SITE}/sitemap-broken.xml`]), { status: 200 });
        }
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new TextEncoder().encode("large error page"));
          },
          cancel() {
            failedBodyCancelled = true;
          },
        });
        return new Response(body, { status: 500 });
      }),
    );

    await expect(getWebsitePages(SITE)).rejects.toThrow("status 500");
    expect(failedBodyCancelled).toBe(true);
  });

  it("follows nested sitemap indexes recursively and dedupes pages and sitemaps", async () => {
    const fetchMock = stubSitemaps({
      [`${SITE}/sitemap.xml`]: sitemapIndex([
        `${SITE}/sitemap-docs.xml`,
        `${SITE}/sitemap-nested-index.xml`,
      ]),
      [`${SITE}/sitemap-nested-index.xml`]: sitemapIndex([
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
    // sitemap.xml is fetched twice: existence check + parsing. Every other sitemap only once.
    expect(fetchedUrls.filter((url) => url === `${SITE}/sitemap-docs.xml`)).toHaveLength(1);
    expect(fetchedUrls.filter((url) => url === `${SITE}/sitemap.xml`)).toHaveLength(2);
  });

  it("falls back to sitemap-index.xml", async () => {
    stubSitemaps({
      [`${SITE}/sitemap-index.xml`]: sitemapIndex([`${SITE}/sitemap-0.xml`]),
      [`${SITE}/sitemap-0.xml`]: urlSet([`${SITE}/a`]),
    });
    expect(await getWebsitePages(SITE)).toEqual([`${SITE}/a`]);
  });
});

describe("getPagesFromSitemap()", () => {
  it(`stops following sitemap indexes nested deeper than ${MAX_SITEMAP_DEPTH}`, async () => {
    // index-0 -> index-1 -> ... -> index-9 -> pages
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) {
      files[`${SITE}/index-${i}.xml`] = sitemapIndex([`${SITE}/index-${i + 1}.xml`]);
    }
    files[`${SITE}/index-10.xml`] = urlSet([`${SITE}/deep`]);
    const fetchMock = stubSitemaps(files);

    const pages = await getPagesFromSitemap(`${SITE}/index-0.xml`);

    expect(pages).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_SITEMAP_DEPTH + 1);
  });

  it(`fetches at most ${SITEMAP_FETCH_CONCURRENCY} sitemaps at the same time`, async () => {
    const children = Array.from({ length: 30 }, (_, i) => `${SITE}/child-${i}.xml`);
    let active = 0;
    let maxActive = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        const body = url.endsWith("index.xml")
          ? sitemapIndex(children)
          : urlSet([url.replace(".xml", "")]);
        return new Response(body, { status: 200 });
      }),
    );

    const pages = await getPagesFromSitemap(`${SITE}/index.xml`);

    expect(pages).toHaveLength(children.length);
    expect(maxActive).toBe(SITEMAP_FETCH_CONCURRENCY);
  });

  it("also respects a per-host limit (LINK_CHECK_HOST_CONCURRENCY) lower than SITEMAP_FETCH_CONCURRENCY", async () => {
    setHostLimiter(new HostLimiter(2));
    try {
      const children = Array.from({ length: 20 }, (_, i) => `${SITE}/child-${i}.xml`);
      let active = 0;
      let maxActive = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request) => {
          const url = String(input);
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active--;
          const body = url.endsWith("index.xml")
            ? sitemapIndex(children)
            : urlSet([url.replace(".xml", "")]);
          return new Response(body, { status: 200 });
        }),
      );

      const pages = await getPagesFromSitemap(`${SITE}/index.xml`);

      expect(pages).toHaveLength(children.length);
      expect(maxActive).toBe(2);
    } finally {
      setHostLimiter(undefined);
    }
  });

  it("retries a sitemap after a 429 with Retry-After", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ++calls === 1
          ? new Response(null, { status: 429, headers: { "Retry-After": "0" } })
          : new Response(urlSet([`${SITE}/page`]), { status: 200 }),
      ),
    );

    expect(await getPagesFromSitemap(`${SITE}/pages.xml`)).toEqual([`${SITE}/page`]);
    expect(calls).toBe(2);
  });
});
