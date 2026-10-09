import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createBaseline } from "./baseline";
import {
  getFileAnnotations,
  getGithubBlobBaseUrl,
  renderJobSummary,
  writeGithubOutputs,
  writeJobSummary,
} from "./github_actions";
import { getJSONReport } from "./report/report";
import type { LinkWithResult } from "./types";

const RUN = { generatedAt: new Date("2026-01-02T03:04:05Z"), durationMs: 1234 };

const broken = (href: string, extra: Partial<LinkWithResult> = {}): LinkWithResult => ({
  href,
  page: "docs/a.md",
  text: "text",
  result: { ok: false, error: "broken link", errorDetail: "File not found" },
  ...extra,
});

const report = (links: LinkWithResult[], baselineHrefs: string[] = []) =>
  getJSONReport({
    ...RUN,
    links,
    siteName: "local files",
    baseline: createBaseline(baselineHrefs.map((href) => ({ href }))),
  });

const tempFile = (name: string) => {
  const path = join(mkdtempSync(join(tmpdir(), "gha-test-")), name);
  writeFileSync(path, "");
  return path;
};

describe("renderJobSummary()", () => {
  const hashNotFound = (href: string, page: string, line?: number): LinkWithResult =>
    broken(href, {
      page,
      line,
      result: {
        ok: false,
        error: "hash not found",
        status: 200,
        errorDetail: "No heading matching #nope in docs/guide.md",
      },
    });

  it("has the verdict in the title and the counts in one line", () => {
    const markdown = renderJobSummary(
      report(
        [
          broken("docs/b.md"),
          hashNotFound("#nope", "docs/guide.md"),
          broken("https://blocked.com", {
            result: { ok: false, error: "could not check", status: 403 },
          }),
          broken("ignored.md"),
          { href: "ok.md", page: "a.md", text: "", result: { ok: true, status: 200 } },
        ],
        ["ignored.md"],
      ),
    );
    expect(markdown).toContain("## ❌ local files: 2 links to fix\n");
    expect(markdown).toContain(
      "**1** broken · **1** missing anchors · 1 could not check · 1 ignored · 5 checked\n",
    );
    expect(renderJobSummary(report([]))).toContain("## ✅ local files: all links OK");
  });

  it("adds the trend when the report has a diff", () => {
    const current = report([broken("a.md")]);
    expect(renderJobSummary(current)).not.toContain("since previous report");
    expect(renderJobSummary({ ...current, diff: { new: 2, fixed: 3 } })).toContain(
      " · +2 new, 3 fixed since previous report\n",
    );
  });

  it("groups pages by target with problem, reason and the first two pages", () => {
    const markdown = renderJobSummary(
      report([
        broken("missing.md", { page: "a.md", line: 3 }),
        hashNotFound("#nope", "docs/guide.md"),
        broken("missing.md", { page: "b.md", line: 4 }),
        broken("missing.md", { page: "c.md" }),
        broken("missing.md", { page: "d.md" }),
      ]),
    );
    expect(markdown).toContain("| Problem | Link | Found on |");
    // Most pages first
    expect(markdown).toContain(
      "| File not found | `missing.md`<br><sub>File not found</sub> | `a.md:3`<br>`b.md:4`<br>+2 more |",
    );
    expect(markdown).toContain(
      "| Anchor not found | `#nope`<br><sub>no heading #nope in docs/guide.md</sub> | `docs/guide.md` |",
    );
    expect(markdown.match(/\| Anchor not found/g)).toHaveLength(1);
  });

  it("shows pages of a site without its origin, and where a link redirects to", () => {
    const markdown = renderJobSummary(
      getJSONReport({
        ...RUN,
        siteName: "docs.example.com",
        links: [
          broken("https://other.com/gone", {
            page: "https://docs.example.com/guide/a?x=1",
            result: {
              ok: false,
              error: "broken link",
              status: 404,
              errorDetail: "Not Found <!doctype html><html>",
              redirectedTo: "https://docs.example.com/login",
            },
          }),
        ],
      }),
    );
    expect(markdown).toContain(
      "| HTTP 404 | `other.com/gone`<br><sub>Not Found · redirects to /login</sub> | [/guide/a?x=1](https://docs.example.com/guide/a?x=1) |",
    );
  });

  it("lists ignored links in a collapsed section with reason and page count", () => {
    const markdown = renderJobSummary(
      getJSONReport({
        ...RUN,
        siteName: "local files",
        links: [broken("https://x.com/old"), broken("https://x.com/old", { page: "b.md" })],
        baseline: createBaseline([{ href: "https://x.com/old", reason: "removed soon" }]),
      }),
    );
    expect(markdown).toContain("<details><summary>2 ignored by baseline</summary>");
    expect(markdown).toContain("| `x.com/old` | removed soon | 2 |");
    expect(markdown).not.toContain("| Problem |");
  });

  it("escapes cells so links cannot break the table or inject markdown/HTML", () => {
    const markdown = renderJobSummary(
      report([
        broken("a|b`c <script>", { page: "[x](javascript:alert(1)) `code`" }),
        broken("x.md", {
          result: {
            ok: false,
            error: "broken link",
            errorDetail: "line 1\r\nline 2 | a & b [y]",
          },
        }),
        broken(`https://example.com/${"x".repeat(500)}`),
      ]),
    );
    expect(markdown).toContain("`a\\|b'c <script>`");
    expect(markdown).toContain("`[x](javascript:alert(1)) 'code'`");
    expect(markdown).toContain("<sub>line 1 line 2 \\| a &amp; b \\[y\\]</sub>");
    expect(markdown).toMatch(/`example\.com\/x+…`/);
    const rows = markdown.split("\n").filter((l) => l.startsWith("| ") && !l.includes("---"));
    for (const row of rows) {
      expect(row.replace(/\\\|/g, "").split("|")).toHaveLength(5);
    }
  });

  it("truncates the table and says so", () => {
    const links = Array.from({ length: 60 }, (_, i) => broken(`missing-${i}.md`));
    const markdown = renderJobSummary(report(links));
    expect(markdown.match(/`missing-\d+\.md`/g)).toHaveLength(50);
    expect(markdown).not.toContain("missing-50.md");
    expect(markdown).toContain("| +10 more, see the full report | | |");
    expect(renderJobSummary(report(links), { limit: 5 })).toContain("| +55 more");
  });

  describe("report link", () => {
    const links = [broken("x.md")];

    it("links the report URL, with the artifact name", () => {
      const markdown = renderJobSummary(report(links), {
        reportUrl: "https://github.com/o/r/actions/runs/1/artifacts/2",
        artifactName: "link-check-report",
      });
      expect(markdown).toContain(
        "[Full report](https://github.com/o/r/actions/runs/1/artifacts/2) (artifact `link-check-report`)",
      );
    });

    it("names the artifact without a URL, never a local path", () => {
      expect(renderJobSummary(report(links), { artifactName: "link-check-report" })).toContain(
        "Full report: artifact `link-check-report`.",
      );
      const markdown = renderJobSummary(report(links), {
        reportPaths: { json: "/runner/tmp/a.json", html: "/runner/tmp/a.html" },
      });
      expect(markdown).toContain("Full report: `a.html`.");
      expect(markdown).not.toContain("/runner");
    });

    it("ignores a URL that is not http(s)", () => {
      expect(renderJobSummary(report(links), { reportUrl: "javascript:alert(1)" })).not.toContain(
        "javascript",
      );
    });
  });
});

describe("writeJobSummary()", () => {
  it("appends to GITHUB_STEP_SUMMARY only when it is set", () => {
    const file = tempFile("summary.md");
    writeFileSync(file, "previous step\n");
    expect(writeJobSummary(report([broken("x.md")]), {}, file)).toBe(true);
    const content = readFileSync(file, "utf8");
    expect(content.startsWith("previous step\n## ❌")).toBe(true);
    expect(writeJobSummary(report([]), {}, "")).toBe(false);
  });

  it("uses the report URL from LINK_CHECK_REPORT_URL", () => {
    vi.stubEnv("LINK_CHECK_REPORT_URL", "https://example.com/report");
    const file = tempFile("url-summary.md");
    writeJobSummary(report([broken("x.md")]), {}, file);
    expect(readFileSync(file, "utf8")).toContain("[Full report](https://example.com/report)");
  });

  it("never falls back to the real GITHUB_STEP_SUMMARY / GITHUB_OUTPUT (like in CI)", () => {
    const summary = tempFile("ci-summary.md");
    const output = tempFile("ci-output");
    vi.stubEnv("GITHUB_STEP_SUMMARY", summary);
    vi.stubEnv("GITHUB_OUTPUT", output);
    expect(writeJobSummary(report([broken("x.md")]), {}, undefined)).toBe(false);
    expect(writeGithubOutputs({ a: 1 }, undefined)).toBe(false);
    expect(readFileSync(summary, "utf8")).toBe("");
    expect(readFileSync(output, "utf8")).toBe("");
  });
});

describe("getFileAnnotations()", () => {
  it("returns errors for links to fix and warnings for links that could not be checked, not for ignored links", () => {
    const annotations = getFileAnnotations(
      report(
        [
          broken("missing.md", {
            line: 7,
            result: { ok: false, error: "broken link", errorDetail: "File not found: missing.md" },
          }),
          broken("#nope", {
            line: 2,
            result: {
              ok: false,
              error: "hash not found",
              status: 200,
              errorDetail: "No heading matching #nope in docs/a.md",
            },
          }),
          broken("https://x.com", {
            page: "README.md",
            result: {
              ok: false,
              error: "broken link",
              status: 404,
              errorDetail: "Not Found <!doctype html>",
            },
          }),
          broken("https://blocked.com", {
            line: 9,
            result: { ok: false, error: "could not check", status: 403 },
          }),
          broken("ignored.md", { line: 1 }),
          { href: "ok.md", page: "a.md", text: "", line: 4, result: { ok: true, status: 200 } },
        ],
        ["ignored.md"],
      ),
    );
    expect(annotations).toEqual([
      "::error file=docs/a.md,line=7,title=File not found::no file missing.md",
      "::error file=README.md,title=HTTP 404::https://x.com: Not Found",
      "::error file=docs/a.md,line=2,title=Anchor not found::no heading #nope in docs/a.md",
      "::warning file=docs/a.md,line=9,title=Could not check (403)::https://blocked.com",
    ]);
  });

  it("escapes workflow command properties and messages", () => {
    const [annotation] = getFileAnnotations(
      report([
        broken("x.md", {
          page: "docs/a,b:c.md",
          line: 3,
          result: { ok: false, error: "broken link", errorDetail: "50% done\nnext" },
        }),
      ]),
    );
    expect(annotation).toBe(
      "::error file=docs/a%2Cb%3Ac.md,line=3,title=File not found::x.md: 50%25 done next",
    );
  });
});

describe("writeGithubOutputs()", () => {
  it("appends outputs to GITHUB_OUTPUT only when it is set", () => {
    const file = tempFile("output");
    expect(writeGithubOutputs({ "links-to-fix": 3, "report-path": "results/x.json" }, file)).toBe(
      true,
    );
    expect(readFileSync(file, "utf8")).toBe("links-to-fix=3\nreport-path=results/x.json\n");
    expect(() => writeGithubOutputs({ a: "x\ny" }, file)).toThrow("single line");
  });
});

describe("getGithubBlobBaseUrl()", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_SHA: SHA,
    GITHUB_WORKSPACE: "/work/repo",
  };

  it("returns the blob URL of the commit when running from the workspace in GitHub Actions", () => {
    expect(getGithubBlobBaseUrl(env, "/work/repo")).toBe(
      `https://github.com/owner/repo/blob/${SHA}/`,
    );
    expect(getGithubBlobBaseUrl(env, "/work/repo/")).toBe(
      `https://github.com/owner/repo/blob/${SHA}/`,
    );
    expect(
      getGithubBlobBaseUrl({ ...env, GITHUB_SERVER_URL: "https://ghe.example.com/" }, "/work/repo"),
    ).toBe(`https://ghe.example.com/owner/repo/blob/${SHA}/`);
  });

  it.each([
    [{ GITHUB_ACTIONS: "" }, "/work/repo"],
    [{}, "/work/repo/docs"],
    [{ GITHUB_WORKSPACE: "" }, "/work/repo"],
    [{ GITHUB_REPOSITORY: "owner/repo/../x" }, "/work/repo"],
    [{ GITHUB_REPOSITORY: "owner" }, "/work/repo"],
    [{ GITHUB_SHA: "main" }, "/work/repo"],
    [{ GITHUB_SERVER_URL: "javascript:alert(1)" }, "/work/repo"],
    [{ GITHUB_SERVER_URL: "http://github.com" }, "/work/repo"],
    [{ GITHUB_SERVER_URL: "https://github.com/x?y" }, "/work/repo"],
  ])("returns undefined for %j (cwd %s)", (overrides, cwd) => {
    expect(getGithubBlobBaseUrl({ ...env, ...overrides }, cwd)).toBeUndefined();
  });
});
