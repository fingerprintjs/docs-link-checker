import { it } from "@effect/vitest";
import { Effect, Logger, LogLevel } from "effect";
import { describe, expect } from "vitest";
import { fakeFetch } from "./test/fake_fetch";
import { testRunLayer } from "./test/layers";
import { checkWebsite, createPrefixFilter } from "./website";

const PAGE_COUNT = 20;
const BASE = "https://site.example.com";

// Site with a sitemap of PAGE_COUNT pages, each linking to one working and one missing URL
const handler = (url: string) => {
  const { pathname } = new URL(url);
  if (pathname === "/sitemap.xml") {
    const urls = Array.from({ length: PAGE_COUNT }, (_, i) => `${BASE}/page-${i}`);
    return new Response(
      `<urlset>${urls.map((loc) => `<url><loc>${loc}</loc></url>`).join("")}</urlset>`,
    );
  }
  if (pathname.startsWith("/page-")) {
    return new Response(`<a href="/ok">ok</a><a href="/missing">missing</a>`);
  }
  return new Response("", { status: pathname === "/ok" ? 200 : 404 });
};

const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(testRunLayer({ fetch: fakeFetch(handler).layer })),
    Effect.provide(Logger.minimumLogLevel(LogLevel.None)),
  );

const pagesOf = (results: { page: string }[]) => new Set(results.map((link) => link.page));

describe("checkWebsite()", () => {
  it.effect("checks the links of all sitemap pages", () =>
    provide(
      Effect.gen(function* () {
        const results = yield* checkWebsite({ websiteUrl: BASE, sampleRate: 1 });

        expect(pagesOf(results).size).toBe(PAGE_COUNT);
        expect(
          results.filter((link) => link.href === `${BASE}/ok`).every((link) => link.result.ok),
        ).toBe(true);
        expect(results.find((link) => link.href === `${BASE}/missing`)?.result).toMatchObject({
          ok: false,
          error: "broken link",
          status: 404,
        });
      }),
    ),
  );

  it.effect("checks only a sample of the pages with the sampleRate option", () =>
    provide(
      Effect.gen(function* () {
        const results = yield* checkWebsite({ websiteUrl: BASE, sampleRate: 0.2 });

        expect(pagesOf(results).size).toBe(4);
      }),
    ),
  );

  it.effect("keeps only the links accepted by the link filter", () =>
    provide(
      Effect.gen(function* () {
        const results = yield* checkWebsite({
          websiteUrl: BASE,
          sampleRate: 0.1,
          linkFilter: createPrefixFilter(["https://other.example", `${BASE}/ok`]),
        });

        expect(results.map((link) => link.href)).toEqual([`${BASE}/ok`, `${BASE}/ok`]);
      }),
    ),
  );
});
