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

const broken = (href: string, extra: Partial<LinkWithResult> = {}): LinkWithResult => ({
  href,
  page: "docs/a.md",
  text: "text",
  result: { ok: false, error: "broken link", errorDetail: "File not found" },
  ...extra,
});

const report = (links: LinkWithResult[], baselineHrefs: string[] = []) =>
  getJSONReport({
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
  it("shows counts and a table of links to fix, escaped, with lines", () => {
    const markdown = renderJobSummary(
      report(
        [
          broken("docs/b|c.md", { line: 3 }),
          broken("https://example.com/x", {
            page: "README.md",
            result: { ok: false, error: "hash not found", status: 200, errorDetail: "a\nb | c" },
          }),
          broken("ignored.md"),
          { href: "ok.md", page: "a.md", text: "", result: { ok: true, status: 200 } },
        ],
        ["ignored.md"],
      ),
      { reportPaths: { json: "results/local-files.json", html: "results/local-files.html" } },
    );
    expect(markdown).toContain("## ❌ Link check: local files");
    expect(markdown).toContain("| 4 | 2 | 1 | 1 | 0 | 0 | 1 |");
    expect(markdown).toContain(
      "| docs/a.md:3 | docs/b\\|c.md | broken link: File not found |\n| README.md | https://example.com/x | hash not found (200): a b \\| c |",
    );
    expect(markdown).not.toContain("ignored.md");
    expect(markdown).not.toContain("Showing the first");
    expect(markdown).toContain("Full report: `results/local-files.html`");
  });

  it("escapes table cells so links cannot break the table or inject markdown/HTML", () => {
    const markdown = renderJobSummary(
      report([
        broken("a|b\\|c <script>&", { page: "[x](javascript:alert(1)) `code`" }),
        broken("line 1\r\nline 2\n\n  line 3\rline 4"),
        broken(`https://example.com/${"x".repeat(500)}`),
      ]),
    );
    expect(markdown).toContain(
      "| \\[x\\](javascript:alert(1)) \\`code\\` | a\\|b\\\\\\|c &lt;script&gt;&amp; |",
    );
    expect(markdown).toContain("| line 1 line 2 line 3 line 4 |");
    const longCell = markdown.match(/https:\/\/example\.com\/x+…/)?.[0];
    expect(longCell).toHaveLength(300);
  });

  it("truncates the table and says so", () => {
    const links = Array.from({ length: 60 }, (_, i) => broken(`missing-${i}.md`));
    const markdown = renderJobSummary(report(links));
    expect(markdown.match(/missing-\d+\.md/g)).toHaveLength(50);
    expect(markdown).toContain("missing-49.md");
    expect(markdown).not.toContain("missing-50.md");
    expect(markdown).toContain("Showing the first 50 of 60 links to fix");
    expect(renderJobSummary(report(links), { limit: 5 })).toContain("Showing the first 5 of 60");
  });

  it("has no table when all links are fine", () => {
    const markdown = renderJobSummary(report([]));
    expect(markdown).toContain("## ✅ Link check");
    expect(markdown).not.toContain("Links to fix");
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
          broken("missing.md", { line: 7 }),
          broken("no-line.md"),
          broken("#nope", {
            line: 2,
            result: { ok: false, error: "hash not found", status: 200, errorDetail: "No heading" },
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
      "::error file=docs/a.md,line=7,title=Broken link::missing.md: broken link: File not found",
      "::error file=docs/a.md,title=Broken link::no-line.md: broken link: File not found",
      "::error file=docs/a.md,line=2,title=Anchor not found::#nope: hash not found (200): No heading",
      "::warning file=docs/a.md,line=9,title=Could not check link::https://blocked.com: could not check (403)",
    ]);
  });
});

describe("getFileAnnotations() escaping", () => {
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
      "::error file=docs/a%2Cb%3Ac.md,line=3,title=Broken link::x.md: broken link: 50%25 done%0Anext",
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
