import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import { it } from "@effect/vitest";
import * as cheerio from "cheerio";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { createBaseline } from "../baseline";
import { LogLayer } from "../logger";
import { makeTestConsole } from "../test/test_console";
import type { LinkWithResult } from "../types";
import { getJSONReport, renderReportToHTML, saveReport } from "./report";

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

const html = renderReportToHTML(getJSONReport({ links, siteName: `<b>site</b>` }));
const $ = cheerio.load(html);

describe("renderReportToHTML()", () => {
  it("has no inline event handlers", () => {
    expect(html).not.toContain("onclick");
    expect($("[onclick], [onerror]").length).toBe(0);
  });

  it("stores the link to copy in a data attribute, with the exact URL", () => {
    const buttons = $("button[data-copy-href]");
    expect(buttons.length).toBe(2);
    expect(buttons.first().attr("data-copy-href")).toBe(EVIL_HREF);
  });

  it("escapes all dynamic text", () => {
    // Injected markup must not become elements or script code
    expect($("script").text()).not.toContain("alert(");
    expect($("b").length).toBe(0);
    expect($("h1").text()).toBe("Link Check Report for <b>site</b>");
    expect($("pre").first().text()).toBe("<img src=x onerror=alert(1)>");
  });

  it("does not render javascript: URLs as links", () => {
    const hrefs = $("a[href]")
      .map((_, a) => $(a).attr("href"))
      .get();
    expect(hrefs.some((href) => href.startsWith("javascript:"))).toBe(false);
    expect(hrefs).toContain(EVIL_HREF);
  });
});

describe("renderReportToHTML() with ignored links", () => {
  const report = getJSONReport({
    links: [
      { ...links[0]!, href: "https://broken.com/" },
      { ...links[0]!, href: "https://ignored.com/", page: "docs/a.md", line: 7 },
    ],
    siteName: "site",
    baseline: createBaseline([{ href: "https://ignored.com/", reason: "<i>known</i>" }]),
  });
  const $ignored = cheerio.load(renderReportToHTML(report));

  it("renders ignored links in a separate section with the reason and line", () => {
    const section = $ignored("[data-section=ignored]");
    expect(section.length).toBe(1);
    expect(section.find("tbody tr").length).toBe(1);
    expect(section.text()).toContain("docs/a.md:7");
    expect(section.text()).toContain("Ignored: <i>known</i>");
    expect(section.text()).not.toContain("unique");
    expect(section.find("i").length).toBe(0);
    expect($ignored("table").first().text()).toContain("https://broken.com/");
    expect($ignored("table").first().text()).not.toContain("https://ignored.com/");
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
    expect(groupedReport.summary.ignored).toBe(5);
    const $grouped = cheerio.load(renderReportToHTML(groupedReport));
    const section = $grouped("[data-section=ignored]");
    const rows = section.find("tbody tr");

    expect(rows.length).toBe(3);
    expect(section.text()).toContain("2 unique links (5 occurrences)");

    const twitter = rows.eq(0);
    expect(
      twitter.find("summary").filter((_, el) => $grouped(el).text() === "3 occurrences"),
    ).toHaveLength(1);
    expect(twitter.find("ul li").length).toBe(3);
    expect(twitter.text()).toContain("https://docs.example.com/a");
    expect(twitter.text()).toContain("https://docs.example.com/c");
    expect(twitter.text()).toContain('"follow"');
    expect(twitter.find("pre")).toHaveLength(1);
    expect(twitter.find("pre").text()).toBe("<html>challenge</html>");
    expect(twitter.find("button[data-copy-href]")).toHaveLength(1);

    const twitterBroken = rows.eq(1);
    expect(twitterBroken.text()).toContain("docs/local.md:4");
    expect(twitterBroken.text()).toContain("broken link");
    expect(twitterBroken.find("ul")).toHaveLength(0);
    expect(twitterBroken.find("pre").text()).toBe("missing");

    const other = rows.eq(2);
    expect(other.find("ul")).toHaveLength(0);
    expect(other.text()).toContain('"Other"');
    expect(other.text()).toContain("Ignored: known");
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
    expect($local("[data-section=ignored]").text()).toContain("3 unique links (5 occurrences)");

    const byDetail = (detail: string) =>
      rows.filter((_, row) => $local(row).text().includes(detail));
    expect(byDetail("missing in a")).toHaveLength(1);
    expect(byDetail("missing in a").text()).toContain("a/README.md");
    expect(byDetail("missing in b").text()).toContain("b/README.md");

    const gone = byDetail("File not found");
    expect(gone).toHaveLength(1);
    expect(
      gone.find("summary").filter((_, el) => $local(el).text() === "3 occurrences"),
    ).toHaveLength(1);
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
    return $markup("td a[href]")
      .map((_, a) => $markup(a).attr("href"))
      .get();
  };

  it("renders local pages and links as plain code text without a source URL", () => {
    const $local = cheerio.load(renderReportToHTML(report));
    // Only the absolute link is a link
    expect(hrefs(renderReportToHTML(report))).toEqual(["https://example.com/x"]);
    expect($local("td code").first().text()).toBe("docs/guide.md:7");
    expect($local("[data-local-link] code").first().text()).toContain("../missing.md");
    // No anchor without href (nothing to click)
    expect($local("td a:not([href])").length).toBe(0);
  });

  it("links local pages (with the line) and relative links to the checked files", () => {
    expect(hrefs(renderReportToHTML(report, { sourceBaseUrl: BASE }))).toEqual([
      `${BASE}docs/guide.md#L7`,
      `${BASE}missing.md`,
      `${BASE}docs/guide.md#L3`,
      `${BASE}docs/guide.md#nope`,
      `${BASE}docs/my%20file.md`,
      `${BASE}root.md`,
      `${BASE}docs/guide.md#L9`,
      // ../../../../escape.md would leave the repository: not linked
      `${BASE}docs/guide.md#L11`,
      "https://example.com/x",
    ]);
  });
});

describe("saveReport()", () => {
  it.effect("creates the output directory and writes the JSON and HTML reports", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = join(yield* fs.makeTempDirectoryScoped(), "nested", "results");
      const report = getJSONReport({ links, siteName: "My Site" });
      const testConsole = makeTestConsole();

      const paths = yield* saveReport(report, dir).pipe(
        Effect.provide(LogLayer({ json: false })),
        Effect.withConsole(testConsole.console),
      );

      expect(paths).toEqual({ json: join(dir, "my-site.json"), html: join(dir, "my-site.html") });
      expect(JSON.parse(yield* fs.readFileString(paths.json))).toEqual(
        JSON.parse(JSON.stringify(report)),
      );
      expect(yield* fs.readFileString(paths.html)).toBe(renderReportToHTML(report));
      expect(testConsole.stdout).toEqual([
        `Saved JSON report to ${paths.json}`,
        `Saved HTML report to ${paths.html}`,
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );
});
