import { it } from "@effect/vitest";
import { Effect, Exit, Logger, LogLevel } from "effect";
import { describe, expect } from "vitest";
import { LogLayer } from "./logger";
import { getWebsitePages, MAX_SITEMAP_DEPTH } from "./sitemap";
import { fakeFetch } from "./test/fake_fetch";
import { testRunLayer } from "./test/layers";
import { makeTestConsole } from "./test/test_console";

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

const SITE = "https://example.com";

/** Serves `files` by URL, everything else is a 404 */
const setup = (files: Record<string, string>) => {
  const fake = fakeFetch((url) =>
    url in files ? new Response(files[url], { status: 200 }) : new Response("", { status: 404 }),
  );
  return {
    fetchedUrls: () => fake.calls.map(({ url }) => url),
    provide: <A, E, R>(effect: Effect.Effect<A, E, R>, { quiet = true } = {}) =>
      effect.pipe(
        Effect.provide(testRunLayer({ fetch: fake.layer })),
        Effect.provide(quiet ? Logger.minimumLogLevel(LogLevel.None) : LogLayer({ json: false })),
      ),
  };
};

describe("getWebsitePages()", () => {
  it.effect("reads pages from a plain sitemap.xml", () => {
    const { provide } = setup({ [`${SITE}/sitemap.xml`]: urlSet([`${SITE}/a`, `${SITE}/b`]) });
    return provide(
      Effect.gen(function* () {
        expect(yield* getWebsitePages(SITE)).toEqual([`${SITE}/a`, `${SITE}/b`]);
      }),
    );
  });

  it.effect("fails loudly when a nested sitemap cannot be fetched", () => {
    const { provide } = setup({
      [`${SITE}/sitemap.xml`]: sitemapIndex([`${SITE}/sitemap-missing.xml`]),
    });
    return provide(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(getWebsitePages(SITE));
        expect(exit).toEqual(
          Exit.fail(
            expect.objectContaining({
              _tag: "HttpStatusError",
              message: `Could not fetch sitemap ${SITE}/sitemap-missing.xml: status 404`,
            }),
          ),
        );
      }),
    );
  });

  it.effect("follows nested sitemap indexes recursively and dedupes pages and sitemaps", () => {
    const { provide, fetchedUrls } = setup({
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
    return provide(
      Effect.gen(function* () {
        const pages = yield* getWebsitePages(SITE);

        expect(pages.toSorted()).toEqual([`${SITE}/blog/1`, `${SITE}/docs/1`, `${SITE}/docs/2`]);
        // Every sitemap is fetched once
        expect(fetchedUrls().toSorted()).toEqual([
          `${SITE}/sitemap-blog.xml`,
          `${SITE}/sitemap-docs.xml`,
          `${SITE}/sitemap-nested-index.xml`,
          `${SITE}/sitemap.xml`,
        ]);
      }),
    );
  });

  it.effect("falls back to sitemap-index.xml", () => {
    const { provide } = setup({
      [`${SITE}/sitemap-index.xml`]: sitemapIndex([`${SITE}/sitemap-0.xml`]),
      [`${SITE}/sitemap-0.xml`]: urlSet([`${SITE}/a`]),
    });
    return provide(
      Effect.gen(function* () {
        expect(yield* getWebsitePages(SITE)).toEqual([`${SITE}/a`]);
      }),
    );
  });
});

describe("getWebsitePages() without sitemap", () => {
  it.effect("returns no pages and logs an error", () => {
    const { provide } = setup({});
    const testConsole = makeTestConsole();
    return provide(
      Effect.gen(function* () {
        expect(yield* getWebsitePages(SITE)).toEqual([]);
        expect(testConsole.stderr.join("\n")).toContain(
          "No sitemap.xml or sitemap-index.xml found",
        );
      }).pipe(Effect.withConsole(testConsole.console)),
      { quiet: false },
    );
  });
});

describe("getWebsitePages() limits", () => {
  it.effect(`stops following sitemap indexes nested deeper than ${MAX_SITEMAP_DEPTH}`, () => {
    // sitemap.xml -> index-1 -> ... -> index-10 -> pages
    const files: Record<string, string> = {};
    files[`${SITE}/sitemap.xml`] = sitemapIndex([`${SITE}/index-1.xml`]);
    for (let i = 1; i < 10; i++) {
      files[`${SITE}/index-${i}.xml`] = sitemapIndex([`${SITE}/index-${i + 1}.xml`]);
    }
    files[`${SITE}/index-10.xml`] = urlSet([`${SITE}/deep`]);
    const { provide, fetchedUrls } = setup(files);
    return provide(
      Effect.gen(function* () {
        expect(yield* getWebsitePages(SITE)).toEqual([]);
        expect(fetchedUrls()).toHaveLength(MAX_SITEMAP_DEPTH + 1);
      }),
    );
  });
});
