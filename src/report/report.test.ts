import { describe, it, expect } from "vitest";
import * as cheerio from "cheerio";
import { getJSONReport, renderReportToHTML } from "./report";
import { LinkWithResult } from "../types";

const EVIL_HREF = `https://example.com/it's"quoted"?q=<script>alert(1)</script>`;

const links: LinkWithResult[] = [
  {
    href: EVIL_HREF,
    page: "https://example.com/page",
    text: `</a><script>alert("text")</script>`,
    result: { ok: false, error: "broken link", status: 404, errorDetail: "<img src=x onerror=alert(1)>" },
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
