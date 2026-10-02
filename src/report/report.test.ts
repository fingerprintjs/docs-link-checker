import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import { createBaseline } from "../baseline";
import type { LinkWithResult } from "../types";
import { getJSONReport, renderReportToHTML } from "./report";

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

const html = renderReportToHTML(getJSONReport({ links, errors: [], siteName: `<b>site</b>` }));
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

  it("includes one script that copies the data attribute", () => {
    const inlineScripts = $("script:not([src])");
    expect(inlineScripts.length).toBe(1);
    expect(inlineScripts.text()).toContain("data-copy-href");
    expect(inlineScripts.text()).toContain("navigator.clipboard.writeText");
  });

  it("escapes all dynamic text", () => {
    // Only the tailwind script and the copy script, nothing injected
    expect($("script").length).toBe(2);
    expect($("img").length).toBe(0);
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
    errors: [],
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
    expect(section.find("i").length).toBe(0);
    expect($ignored("table").first().text()).toContain("https://broken.com/");
    expect($ignored("table").first().text()).not.toContain("https://ignored.com/");
  });

  it("has no ignored section without ignored links", () => {
    expect($("[data-section=ignored]").length).toBe(0);
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
    errors: [],
    links: [
      local("docs/guide.md", "../missing.md", 7),
      local("docs/guide.md", "#nope", 3),
      local("docs/my file.md", "/root.md"),
      local("docs/guide.md", "../../../../escape.md", 9),
      local("docs/guide.md", "https://example.com/x", 11),
    ],
  });
  const hrefs = (markup: string) =>
    cheerio
      .load(markup)("td a[href]")
      .map((_, a) => cheerio.load(markup)(a).attr("href"))
      .get();

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
