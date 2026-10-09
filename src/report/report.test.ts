import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import { createBaseline } from "../baseline";
import type { LinkWithResult } from "../types";
import { getJSONReport, renderReportToHTML } from "./report";

const RUN = { generatedAt: new Date("2026-01-02T03:04:05Z"), durationMs: 1234 };

const EVIL_HREF = `https://example.com/it's"quoted"?q=<script>alert(1)</script>`;

const links: LinkWithResult[] = [
  {
    href: EVIL_HREF,
    page: "https://example.com/page",
    text: `</a><script>alert("text")</script>`,
    result: {
      ok: false,
      error: "broken link",
      status: 404,
      errorDetail: "<img src=x onerror=alert(1)>",
    },
  },
  {
    href: "javascript:alert(1)",
    page: "https://example.com/page",
    text: "js link",
    result: { ok: false, error: "broken link" },
  },
];

const html = renderReportToHTML(getJSONReport({ ...RUN, links, siteName: `<b>site</b>` }));
const $ = cheerio.load(html);

describe("renderReportToHTML()", () => {
  it("has no inline event handlers", () => {
    expect(html).not.toContain("onclick");
    expect($("[onclick], [onerror]").length).toBe(0);
  });

  it("is self-contained: no external scripts, styles or requests", () => {
    expect($("script[src], link[rel=stylesheet], img, iframe").length).toBe(0);
    expect(html).not.toContain("tailwind");
  });

  it("stores the link to copy in a data attribute, with the exact URL", () => {
    const buttons = $("#by-link button[data-copy-href]");
    expect(buttons.length).toBe(2);
    expect(buttons.first().attr("data-copy-href")).toBe(EVIL_HREF);
  });

  it("escapes all dynamic text", () => {
    // Injected markup must not become elements or script code
    expect($("script").text()).not.toContain("alert(");
    expect($("b").length).toBe(0);
    expect($("h1").text()).toBe("<b>site</b> 2 to fix");
    expect($("pre").first().text()).toBe("<img src=x onerror=alert(1)>");
  });

  it("does not render javascript: URLs as links", () => {
    const hrefs = $("a[href]")
      .map((_, a) => $(a).attr("href"))
      .get();
    expect(hrefs.some((href) => href.startsWith("javascript:"))).toBe(false);
    expect(hrefs).toContain(EVIL_HREF);
  });

  it("links pages with a text fragment of the link text", () => {
    const pageLink = $("#by-link tbody tr").first().find("td").eq(2).find("a");
    expect(pageLink.attr("href")).toBe(
      `https://example.com/page#:~:text=${encodeURIComponent(links[0]!.text)}`,
    );
    expect(pageLink.text()).toBe("/page");
  });
});

describe("renderReportToHTML() header", () => {
  const render = (overrides: Parameters<typeof getJSONReport>[0]) =>
    cheerio.load(renderReportToHTML(getJSONReport(overrides)));

  it("puts the status in the title and a short stats line in the header", () => {
    expect($("title").text()).toBe("✗ 2 to fix · <b>site</b>");
    const stats = $(".stats").text();
    expect(stats).toContain("2 broken");
    expect(stats).toContain("0 anchor");
    expect(stats).toContain("0 ignored");
    expect(stats).toContain("2 checked");
    expect($("header").text()).toContain("2026-01-02 03:04 UTC");
    expect($("header").text()).toContain("1.2s");
    expect($("header a[href]").attr("href")).toBe("-b-site--b-.json");
  });

  it("shows the trend only when there is a previous report", () => {
    expect($("header").text()).not.toContain("fixed");
    const withDiff = render({
      ...RUN,
      links,
      siteName: "site",
      previous: {
        linksToFix: [
          { page: "https://example.com/old", href: "https://old/", error: "broken link" },
        ],
      },
    });
    expect(withDiff("header").text()).toContain("+2 new, 1 fixed");
  });

  it("shows one line when all links are OK", () => {
    const ok = render({
      ...RUN,
      siteName: "site",
      links: [
        {
          href: "https://example.com/",
          page: "https://example.com/a",
          text: "a",
          result: { ok: true, status: 200 },
        },
      ],
    });
    expect(ok("title").text()).toBe("✓ OK · site");
    expect(ok("h1").text()).toBe("site ✓ OK");
    expect(ok("main").length).toBe(0);
    expect(ok("body").text()).toContain("✓ No links to fix");
  });

  it("shows the redirect target and only the response body that adds information", () => {
    const redirected = render({
      ...RUN,
      siteName: "site",
      links: [
        {
          href: "https://old.example.com/x",
          page: "https://example.com/a",
          text: "a",
          result: {
            ok: false,
            error: "broken link",
            status: 404,
            errorDetail: "Not Found",
            redirectedTo: "https://new.example.com/x",
          },
        },
        {
          href: "https://example.com/missing",
          page: "https://example.com/a",
          text: "b",
          result: {
            ok: false,
            error: "broken link",
            status: 404,
            errorDetail: "Not Found <!doctype html><p>Nothing here</p>",
          },
        },
      ],
    });
    const rows = redirected("#by-link tbody tr");
    expect(rows.eq(0).text()).toContain("→ redirects to new.example.com/x");
    expect(rows.eq(0).find("pre")).toHaveLength(0);
    expect(rows.eq(1).find("pre").text()).toBe("Not Found <!doctype html><p>Nothing here</p>");
  });
});

describe("renderReportToHTML() views", () => {
  const page = (path: string) => `https://example.com/${path}`;
  const broken = (href: string, pageUrl: string, line?: number): LinkWithResult => ({
    href,
    page: pageUrl,
    text: "text",
    ...(line ? { line } : {}),
    result: { ok: false, error: "broken link", status: 404, errorDetail: "Not Found" },
  });
  const report = getJSONReport({
    ...RUN,
    siteName: "site",
    links: [
      ...["a", "b", "c", "d", "e"].map((name) => broken("https://gone.example/x", page(name))),
      broken("https://gone.example/y", page("a")),
      {
        href: "https://example.com/doc#nope",
        page: page("b"),
        text: "t",
        result: { ok: false, error: "hash not found" },
      },
    ],
  });
  const $views = cheerio.load(renderReportToHTML(report));

  it("by link: one row per target, most pages first, with the first 3 pages and the rest folded", () => {
    const rows = $views("#by-link tbody tr");
    expect(rows).toHaveLength(3);
    expect(rows.eq(0).text()).toContain("gone.example/x");
    expect(rows.eq(0).children("td").eq(2).children(".pg")).toHaveLength(3);
    expect(rows.eq(0).find("details summary").text()).toBe("+2 more");
    expect(rows.eq(0).find("details .pg")).toHaveLength(2);
    expect(rows.eq(0).attr("data-kind")).toBe("broken");
    expect(rows.eq(2).attr("data-kind")).toBe("anchor");
    // The anchor is highlighted and the site origin is dropped
    expect(rows.eq(2).find(".hash").text()).toBe("#nope");
    expect(rows.eq(2).find("td").eq(1).text()).toContain("/doc#nope");
  });

  it("by page: links are grouped under their page", () => {
    const pages = $views("#by-page tbody[data-page]");
    expect(pages).toHaveLength(5);
    const b = pages.filter((_, el) => $views(el).attr("data-page") === page("b"));
    expect(b.find("tr[data-row]")).toHaveLength(2);
    expect(b.find("tr.ph").text()).toContain("/b");
    expect($views("#by-page").attr("hidden")).toBeDefined();
  });

  it("starts with the toolbar hidden (it needs the script)", () => {
    expect($views("#bar").attr("hidden")).toBeDefined();
  });
});

describe("renderReportToHTML() with ignored links", () => {
  const report = getJSONReport({
    ...RUN,
    links: [
      { ...links[0]!, href: "https://broken.com/" },
      { ...links[0]!, href: "https://ignored.com/", page: "docs/a.md", line: 7 },
    ],
    siteName: "site",
    baseline: createBaseline([{ href: "https://ignored.com/", reason: "<i>known</i>" }]),
  });
  const $ignored = cheerio.load(renderReportToHTML(report));

  it("renders ignored links in a collapsed section with the reason and line", () => {
    const section = $ignored("[data-section=ignored]");
    expect(section.length).toBe(1);
    expect(section.attr("open")).toBeUndefined();
    expect(section.find("summary").first().text()).toBe("1 ignored by baseline (1 link)");
    expect(section.find("tbody tr").length).toBe(1);
    expect(section.text()).toContain("docs/a.md:7");
    expect(section.find("tbody td.rs").text()).toBe("<i>known</i>");
    expect(section.find("i").length).toBe(0);
    expect($ignored("#by-link").text()).toContain("broken.com/");
    expect($ignored("#by-link").text()).not.toContain("ignored.com/");
  });

  it("has no ignored section without ignored links", () => {
    expect($("[data-section=ignored]").length).toBe(0);
  });

  it("groups ignored links that share a URL, error, and reason", () => {
    const couldNotCheck: LinkWithResult["result"] = {
      ok: false,
      error: "could not check",
      status: 403,
      errorDetail: "<html>challenge</html>",
    };
    const groupedReport = getJSONReport({
      ...RUN,
      siteName: "site",
      links: [
        {
          href: "https://twitter.com/x",
          page: "https://docs.example.com/a",
          text: "x",
          result: couldNotCheck,
        },
        {
          href: "https://twitter.com/x",
          page: "https://docs.example.com/b",
          text: "x",
          result: { ...couldNotCheck, errorDetail: "<html>other nonce</html>" },
        },
        {
          href: "https://twitter.com/x",
          page: "https://docs.example.com/c",
          text: "follow",
          result: couldNotCheck,
        },
        {
          href: "https://twitter.com/x",
          page: "https://docs.example.com/d",
          text: "x",
          result: couldNotCheck,
        },
        {
          href: "https://twitter.com/x",
          page: "docs/local.md",
          text: "x",
          line: 4,
          result: { ok: false, error: "broken link", status: 404, errorDetail: "missing" },
        },
        {
          href: "https://other.example/",
          page: "https://docs.example.com/d",
          text: "Other",
          result: couldNotCheck,
        },
      ],
      baseline: createBaseline([
        { pattern: "https://twitter.com/**", reason: "bot wall" },
        { href: "https://other.example/", reason: "known" },
      ]),
    });
    expect(groupedReport.summary.ignored).toBe(6);
    const $grouped = cheerio.load(renderReportToHTML(groupedReport));
    const section = $grouped("[data-section=ignored]");
    const rows = section.find("tbody tr");

    expect(rows.length).toBe(3);
    expect(section.find("summary").first().text()).toBe("6 ignored by baseline (3 links)");

    const twitter = rows.eq(0);
    expect(twitter.children("td").eq(2).children(".pg")).toHaveLength(3);
    expect(twitter.children("td").eq(2).find("summary").text()).toBe("+1 more");
    expect(twitter.text()).toContain("/a");
    expect(twitter.text()).toContain('"follow"');
    expect(twitter.find("td.rs").text()).toBe("bot wall");
    expect(twitter.find("pre")).toHaveLength(1);
    expect(twitter.find("pre").text()).toBe("<html>challenge</html>");
    expect(twitter.find("button[data-copy-href]")).toHaveLength(1);

    const twitterBroken = rows.eq(1);
    expect(twitterBroken.text()).toContain("docs/local.md:4");
    expect(twitterBroken.text()).toContain("HTTP 404");
    expect(twitterBroken.find("details")).toHaveLength(0);
    // The response body only repeats the reason
    expect(twitterBroken.find("pre")).toHaveLength(0);

    const other = rows.eq(2);
    expect(other.find("details")).toHaveLength(1); // the response body, no folded pages
    expect(other.text()).toContain('"Other"');
    expect(other.find("td.rs").text()).toBe("known");
    expect(other.find("button[data-copy-href]").attr("data-copy-href")).toBe(
      "https://other.example/",
    );
  });

  it("resolves a relative link against its file before grouping", () => {
    const broken = {
      ok: false as const,
      error: "broken link" as const,
      errorDetail: "File not found",
    };
    const localIgnored = getJSONReport({
      ...RUN,
      siteName: "local files",
      links: [
        {
          href: "missing.md",
          page: "a/README.md",
          text: "missing",
          result: { ...broken, errorDetail: "missing in a" },
        },
        {
          href: "missing.md",
          page: "b/README.md",
          text: "missing",
          result: { ...broken, errorDetail: "missing in b" },
        },
        { href: "../gone.md", page: "docs/guide.md", text: "gone", line: 2, result: broken },
        { href: "gone.md", page: "README.md", text: "gone", result: broken },
        { href: "gone.md", page: "README.md", text: "gone again", line: 9, result: broken },
      ],
      baseline: createBaseline([{ pattern: "**" }]),
    });
    const $local = cheerio.load(renderReportToHTML(localIgnored));
    const rows = $local("[data-section=ignored] tbody tr");

    expect(rows).toHaveLength(3);
    expect($local("[data-section=ignored] summary").first().text()).toBe(
      "5 ignored by baseline (3 links)",
    );
    // No reason in the baseline: the reason cell is still there, the copy button stays in its column
    const headerCells = $local("[data-section=ignored] thead th").length;
    rows.each((_, row) => {
      expect($local(row).children("td")).toHaveLength(headerCells);
    });

    const byReason = (reason: string) =>
      rows.filter((_, row) => $local(row).text().includes(reason));
    expect(byReason("missing in a")).toHaveLength(1);
    expect(byReason("missing in a").text()).toContain("a/README.md");
    expect(byReason("missing in b").text()).toContain("b/README.md");

    const gone = rows.filter((_, row) => $local(row).find(".pg").length === 3);
    expect(gone).toHaveLength(1);
    expect(gone.text()).toContain("docs/guide.md:2");
    expect(gone.text()).toContain("README.md:9");
  });
});

describe("renderReportToHTML() for local files", () => {
  const BASE = "https://github.com/owner/repo/blob/0123456789abcdef0123456789abcdef01234567/";
  const local = (page: string, href: string, line?: number): LinkWithResult => ({
    page,
    href,
    text: "text",
    ...(line ? { line } : {}),
    result: { ok: false, error: "broken link", errorDetail: "File not found" },
  });
  const report = getJSONReport({
    ...RUN,
    siteName: "local files",
    links: [
      local("docs/guide.md", "../missing.md", 7),
      local("docs/guide.md", "#nope", 3),
      local("docs/my file.md", "/root.md"),
      local("docs/guide.md", "../../../../escape.md", 9),
      local("docs/guide.md", "https://example.com/x", 11),
    ],
  });
  const hrefs = (markup: string) => {
    const $markup = cheerio.load(markup);
    return $markup("#by-link td a[href]")
      .map((_, a) => $markup(a).attr("href"))
      .get();
  };

  it("renders local pages and links as plain code text without a source URL", () => {
    const $local = cheerio.load(renderReportToHTML(report));
    // Only the absolute link is a link
    expect(hrefs(renderReportToHTML(report))).toEqual(["https://example.com/x"]);
    expect($local("#by-link code").first().text()).toBe("docs/guide.md:7");
    expect($local("#by-link [data-local-link]").first().text()).toBe("../missing.md");
    // No anchor without href (nothing to click)
    expect($local("td a:not([href])").length).toBe(0);
  });

  it("links local pages (with the line) and relative links to the checked files", () => {
    // Per row: the link, then its page
    expect(hrefs(renderReportToHTML(report, { sourceBaseUrl: BASE }))).toEqual([
      `${BASE}missing.md`,
      `${BASE}docs/guide.md#L7`,
      `${BASE}docs/guide.md#nope`,
      `${BASE}docs/guide.md#L3`,
      `${BASE}root.md`,
      `${BASE}docs/my%20file.md`,
      // ../../../../escape.md would leave the repository: not linked
      `${BASE}docs/guide.md#L9`,
      "https://example.com/x",
      `${BASE}docs/guide.md#L11`,
    ]);
  });
});

describe("getJSONReport() metadata", () => {
  it("has the schema version and the time and duration it is given", () => {
    const report = getJSONReport({ ...RUN, links: [], siteName: "site" });

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: "2026-01-02T03:04:05.000Z",
      durationMs: 1234,
    });
    expect(report).not.toHaveProperty("diff");
  });

  it("shows a duration just under 2 minutes as 2m 0s", () => {
    const report = getJSONReport({ ...RUN, durationMs: 119_999, links: [], siteName: "site" });
    expect(cheerio.load(renderReportToHTML(report))("header").text()).toContain("2m 0s");
  });
});
