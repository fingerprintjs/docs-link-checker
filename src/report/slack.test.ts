import { describe, expect, it } from "vitest";
import type { LinkWithResult } from "../types";
import { getJSONReport } from "./report";
import { parseSlackReport, renderSlackMessage } from "./slack";

const OPTIONS = { indexUrl: "https://pages.example/" };

const FOOTER =
  "_Reminders repeat every 7 days while a link stays broken. <https://pages.example/|All reports>_";

type SavedLink = { href: string; page?: string; notify?: string; brokenSince?: string };

/** A saved JSON report, as the check jobs write it */
const savedReport = (siteName: string, links: SavedLink[]) => ({
  siteName,
  brokenLinks: links.map(({ href, page = "https://site.example/docs/a", notify, brokenSince }) => ({
    page,
    href,
    text: "",
    result: { ok: false, error: "broken link", status: 404 },
    brokenSince: brokenSince ?? "2026-10-21T03:17:00.000Z",
    ...(notify ? { notify } : {}),
  })),
  hashNotFound: [],
  networkErrors: [],
});

const render = (...reports: Array<{ name: string; json: unknown }>) =>
  renderSlackMessage(
    reports.map(({ name, json }) => ({
      report: parseSlackReport(json),
      url: `https://pages.example/${name}.html`,
    })),
    OPTIONS,
  );

describe("renderSlackMessage()", () => {
  it("lists new links and reminders per report, one line for a report without them", () => {
    const readmes = savedReport("READMEs", [
      { href: "https://new.example/", notify: "new" },
      {
        href: "https://old.example/",
        notify: "reminder",
        brokenSince: "2026-10-14T03:17:00.000Z",
      },
      { href: "https://old.example/", page: "https://site.example/docs/b", notify: "reminder" },
      { href: "https://quiet.example/" },
    ]);
    const docs = savedReport("docs.example", [{ href: "https://quiet.example/" }]);
    const web = savedReport("web.example", []);

    expect(
      render(
        { name: "readmes", json: readmes },
        { name: "docs", json: docs },
        { name: "web", json: web },
      ),
    ).toBe(
      [
        "*Link check: 2 broken links to look at*",
        "",
        "*READMEs* · 1 new, 1 reminder · <https://pages.example/readmes.html|report>",
        "• 🆕 `HTTP 404` <https://new.example/>",
        "    on <https://site.example/docs/a|/docs/a>",
        "• ⏰ `HTTP 404` <https://old.example/>, broken since Oct 14",
        "    on <https://site.example/docs/a|/docs/a> and 1 more page",
        "",
        "*docs.example* · nothing new, 1 still broken · <https://pages.example/docs.html|report>",
        "*web.example* · nothing new · <https://pages.example/web.html|report>",
        "",
        FOOTER,
      ].join("\n"),
    );
  });

  it("returns nothing when no report has a link to notify about", () => {
    const docs = savedReport("docs.example", [{ href: "https://quiet.example/" }]);
    expect(render({ name: "docs", json: docs })).toBeUndefined();
    expect(
      render({
        name: "docs",
        json: savedReport("docs.example", [{ href: "https://a/", notify: "new" }]),
      }),
    ).toContain("1 broken link to look at");
  });

  it("lists the first 10 links of a report and counts the rest", () => {
    const links = Array.from({ length: 12 }, (_, i) => ({
      href: `https://e.example/${i}`,
      notify: "new",
    }));
    const message = render({ name: "docs", json: savedReport("docs.example", links) }) ?? "";

    expect(message.match(/^• /gm)).toHaveLength(10);
    expect(message).toContain("\n+2 more in the report\n");
  });

  it("escapes text and links, so a link can't inject Slack formatting", () => {
    const message = render({
      name: "docs",
      json: savedReport("<!channel> & co", [
        { href: "https://e.example/?a=<b>&c|d", page: "https://site.example/<x>", notify: "new" },
      ]),
    });

    expect(message).toContain("*&lt;!channel&gt; &amp; co*");
    expect(message).toContain("<https://e.example/?a=&lt;b&gt;&amp;c%7Cd>");
    expect(message).toContain("<https://site.example/&lt;x&gt;|/%3Cx%3E>");
  });
});

describe("parseSlackReport()", () => {
  it("reads a saved report", () => {
    const link: LinkWithResult = {
      page: "https://site.example/docs/a",
      href: "https://e.example/#gone",
      text: "",
      result: { ok: false, error: "hash not found" },
    };
    const report = getJSONReport({
      links: [link],
      siteName: "docs.example",
      generatedAt: new Date("2026-10-21T03:17:00Z"),
      durationMs: 0,
    });
    const saved = parseSlackReport(JSON.parse(JSON.stringify(report)));

    expect(
      renderSlackMessage([{ report: saved, url: "https://pages.example/docs.html" }], OPTIONS),
    ).toContain("• 🆕 `Anchor not found` <https://e.example/#gone>");
  });
});
