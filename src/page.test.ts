import { it } from "@effect/vitest";
import { Effect, Logger, LogLevel } from "effect";
import { describe, expect } from "vitest";
import { filterOutIrrelevantLinks, getLinksFromPages } from "./page";
import { type FetchHandler, fakeFetch } from "./test/fake_fetch";
import { testRunLayer } from "./test/layers";

const link = (href: string) => ({ href, text: "text", page: "https://example.com/page" });

describe("filterOutIrrelevantLinks()", () => {
  it("keeps http(s) links and unparsable URLs (reported as broken later)", () => {
    const links = [link("https://example.com/a"), link("http://example.com/b"), link("not a url")];
    expect(filterOutIrrelevantLinks(links)).toEqual(links);
  });

  it("skips links with non-http(s) schemes", () => {
    const links = [
      "tel:+123",
      "javascript:void(0)",
      "data:text/plain,hi",
      "mailto:a@b.com",
      "ftp://example.com/f",
    ];
    expect(filterOutIrrelevantLinks(links.map(link))).toEqual([]);
  });

  it.each([
    "http://localhost:3000/docs",
    "https://apps.apple.com/app/id123",
    "https://console.aws.amazon.com/iam",
    "https://eu-west-1.console.aws.amazon.com/ec2",
    "https://portal.azure.com/#home",
    "https://example.com/cdn-cgi/l/email-protection#1e6d",
    "https://dash.cloudflare.com/login",
    "doc:some-page",
    "ref:some-page",
    "https://dev.fingerprint.com/recipes/some-recipe",
    "https://dev.fingerprint.com/discuss/some-thread",
  ])("skips the known unreachable or login-only link %s", (href) => {
    expect(filterOutIrrelevantLinks([link(href)])).toEqual([]);
  });

  // Hosts are matched exactly, a similar URL on another host or path must still be checked
  it.each([
    "https://example.com/localhost",
    "https://example.com/apps.apple.com",
    "https://example.com/portal.azure.com",
    "https://example.com/dash.cloudflare.com",
    "https://portal.azure.com.example.com/",
    "https://dash.cloudflare.com.example.com/",
    "https://dev.fingerprint.com/reference/get-event",
    "https://dev.fingerprint.com/docs/recipes",
    "https://example.com/doc:page",
    "https://example.com/ref:page",
    "https://example.com/cdn-cgi/l/other",
  ])("keeps the similar but relevant link %s", (href) => {
    const links = [link(href)];
    expect(filterOutIrrelevantLinks(links)).toEqual(links);
  });
});

describe("getLinksFromPages()", () => {
  const provide = <A, E, R>(handler: FetchHandler, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(testRunLayer({ fetch: fakeFetch(handler).layer })),
      Effect.provide(Logger.minimumLogLevel(LogLevel.None)),
    );

  it.effect(
    "reports a page that still fails after the retries as an extraction error (not silently empty)",
    () =>
      provide(
        (url) =>
          url.endsWith("/limited")
            ? new Response(null, { status: 429, headers: { "Retry-After": "0" } })
            : new Response('<a href="https://example.com/target">Target</a>', { status: 200 }),
        Effect.gen(function* () {
          const { links, errors } = yield* getLinksFromPages({
            pages: ["https://docs.example.com/limited", "https://docs.example.com/ok"],
          });

          expect(links).toHaveLength(1);
          expect(errors).toHaveLength(1);
          expect(errors[0]?.item).toBe("https://docs.example.com/limited");
          expect(String(errors[0]?.error)).toContain("status: 429");
        }),
      ),
  );

  it.effect("resolves relative links against the page and drops irrelevant ones", () =>
    provide(
      () =>
        new Response(
          '<a href="/abs">A</a><a href="rel">R</a><a href="mailto:a@b.com">M</a><a>No href</a>',
          { status: 200 },
        ),
      Effect.gen(function* () {
        const { links, errors } = yield* getLinksFromPages({
          pages: ["https://docs.example.com/dir/page"],
        });

        expect(errors).toEqual([]);
        expect(links).toEqual([
          {
            href: "https://docs.example.com/abs",
            text: "A",
            page: "https://docs.example.com/dir/page",
          },
          {
            href: "https://docs.example.com/dir/rel",
            text: "R",
            page: "https://docs.example.com/dir/page",
          },
        ]);
      }),
    ),
  );

  it.effect("keeps only the links accepted by the link filter", () =>
    provide(
      () => new Response('<a href="https://a.com/1">1</a><a href="https://b.com/2">2</a>'),
      Effect.gen(function* () {
        const { links } = yield* getLinksFromPages({
          pages: ["https://docs.example.com/page"],
          linkFilter: (found) => found.href.startsWith("https://b.com"),
        });

        expect(links.map((found) => found.href)).toEqual(["https://b.com/2"]);
      }),
    ),
  );
});
