import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBaseline } from "./baseline";
import { checkLinks } from "./link";
import {
  checkLocalFiles,
  checkLocalLink,
  collectLinksFromFiles,
  extractMarkdownLinks,
  findMarkdownFiles,
  findReadme,
  getLinkKind,
} from "./local_files";

vi.mock("./link", () => ({
  checkLinks: vi.fn(async ({ links }: { links: Array<{ href: string }> }) => ({
    results: links.map((link) => ({ ...link, result: { ok: true, status: 200 } })),
    errors: [],
  })),
}));

const FIXTURE = resolve(import.meta.dirname, "__fixtures__/local");
const check = (file: string, href: string) =>
  checkLocalLink(join(FIXTURE, file), href, { root: FIXTURE });

describe("getLinkKind()", () => {
  it.each([
    ["https://example.com", "external"],
    ["HTTP://example.com", "external"],
    ["//cdn.example.com/x", "external"],
    ["mailto:a@b.c", "skip"],
    ["tel:+123", "skip"],
    ["data:text/plain,x", "skip"],
    ["", "skip"],
    ["docs/a.md", "local"],
    ["./a.md", "local"],
    ["../a.md", "local"],
    ["/docs/a.md", "local"],
    ["#anchor", "local"],
    ["a.md?x=1:2", "local"],
  ])("%s -> %s", (href, kind) => {
    expect(getLinkKind(href)).toBe(kind);
  });
});

describe("extractMarkdownLinks()", () => {
  it("returns links with line numbers, ignoring code blocks", () => {
    const markdown = [
      "# Title", // 1
      "", // 2
      "[a](a.md) and [b](b.md)", // 3
      "```", // 4
      "[code](code.md)", // 5
      "```", // 6
      "| col | col |", // 7
      "| --- | --- |", // 8
      "| [t](t.md) | x |", // 9
      "> quote [q](q.md)", // 10
      "[a](a.md)", // 11
      "<https://auto.link>", // 12
    ].join("\n");
    expect(extractMarkdownLinks(markdown)).toEqual([
      { href: "a.md", text: "a", line: 3 },
      { href: "b.md", text: "b", line: 3 },
      { href: "t.md", text: "t", line: 9 },
      { href: "q.md", text: "q", line: 10 },
      // Same link again: found after the first one
      { href: "a.md", text: "a", line: 11 },
      { href: "https://auto.link", text: "https://auto.link", line: 12 },
    ]);
  });

  it("handles CRLF line endings and formatted link text", () => {
    expect(extractMarkdownLinks("line\r\n\r\n[**bold** `code`](x.md)\r\n")).toEqual([
      { href: "x.md", text: "bold code", line: 3 },
    ]);
  });

  it("resolves reference links", () => {
    expect(extractMarkdownLinks("text\n\n[ref link][ref]\n\n[ref]: docs/a.md#x\n")).toEqual([
      { href: "docs/a.md#x", text: "ref link", line: 3 },
    ]);
  });
});

describe("checkLocalLink()", () => {
  it("accepts existing files and directories (relative, root-relative, encoded, with a query string)", () => {
    for (const href of [
      "docs/guide.md",
      "./docs/guide.md",
      "docs/",
      "docs",
      "/docs/guide.md",
      "docs/with%20space.md",
      "docs/guide.md?plain=1",
      "src/code.ts",
    ]) {
      expect(check("README.md", href), href).toEqual({ ok: true, status: 200 });
    }
    expect(check("docs/guide.md", "../README.md")).toEqual({ ok: true, status: 200 });
  });

  it("reports missing files as broken links, relative to the root", () => {
    expect(check("README.md", "docs/missing.md")).toEqual({
      ok: false,
      error: "broken link",
      errorDetail: "File not found: docs/missing.md",
    });
    expect(check("docs/guide.md", "../nope.md#x")).toMatchObject({
      error: "broken link",
      errorDetail: "File not found: nope.md",
    });
    expect(check("docs/guide.md", "guide.md/extra")).toMatchObject({ error: "broken link" });
  });

  it("checks anchors against headings of markdown files", () => {
    expect(check("README.md", "docs/guide.md#installation")).toEqual({ ok: true, status: 200 });
    expect(check("README.md", "docs/guide.md?plain=1#installation").ok).toBe(true);
    expect(check("README.md", "docs/guide.md#Installation").ok).toBe(true);
    expect(check("README.md", "docs/guide.md#user-content-installation").ok).toBe(true);
    expect(check("README.md", "#getting-started").ok).toBe(true);
    expect(check("docs/guide.md", "../README.md#getting-started").ok).toBe(true);
    expect(check("README.md", "docs/guide.md#nope")).toEqual({
      ok: false,
      error: "hash not found",
      status: 200,
      errorDetail: "No heading matching #nope in docs/guide.md",
    });
    expect(check("README.md", "#nowhere")).toMatchObject({
      error: "hash not found",
      errorDetail: "No heading matching #nowhere in README.md",
    });
  });

  it("checks anchors on directories against their README", () => {
    expect(check("README.md", "docs#docs-index").ok).toBe(true);
    expect(check("README.md", "docs/#nope")).toMatchObject({
      error: "hash not found",
      errorDetail: "No heading matching #nope in docs/README.md",
    });
    expect(check("README.md", "src#anything")).toMatchObject({
      ok: true,
      note: "Hash not checked (directory without README)",
    });
  });

  it("checks GitHub line anchors on code files, ignores other anchors", () => {
    expect(check("README.md", "src/code.ts#L3").ok).toBe(true);
    expect(check("README.md", "src/code.ts#L2-L3").ok).toBe(true);
    expect(check("README.md", "src/code.ts#L2C5-L3C1").ok).toBe(true);
    expect(check("README.md", "src/code.ts#L4")).toMatchObject({
      error: "hash not found",
      errorDetail: "src/code.ts has only 3 lines",
    });
    expect(check("README.md", "src/code.ts#L1-L99").ok).toBe(false);
    expect(check("README.md", "src/code.ts#something")).toMatchObject({
      ok: true,
      note: "Hash not checked (not a markdown file)",
    });
  });

  it("accepts accidental hashes and text fragments", () => {
    expect(check("README.md", "docs/guide.md#/").ok).toBe(true);
    expect(check("README.md", "docs/guide.md#:~:text=Usage")).toMatchObject({
      ok: true,
      note: "Text Fragment",
    });
  });
});

describe("findReadme() and directory anchors", () => {
  const makeDir = (files: Record<string, string>, dirs: string[] = []) => {
    const dir = mkdtempSync(join(tmpdir(), "readme-test-"));
    for (const name of dirs) mkdirSync(join(dir, name));
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    return dir;
  };
  // Case-insensitive filesystems (macOS, Windows) can't have README.md and readme.md side by side
  const caseSensitive = (() => {
    const dir = makeDir({ a: "" });
    return !existsSync(join(dir, "A"));
  })();

  it("finds README.markdown and lowercase or mixed-case names", () => {
    expect(findReadme(makeDir({ "README.markdown": "# X" }))).toMatch(/README\.markdown$/);
    expect(findReadme(makeDir({ "readme.md": "# X" }))).toMatch(/readme\.md$/);
    expect(findReadme(makeDir({ "Readme.Markdown": "# X" }))).toMatch(/Readme\.Markdown$/);
    expect(findReadme(makeDir({ "README.txt": "", "notes.md": "" }))).toBeUndefined();
  });

  it("prefers .md over .markdown and ignores directories named like a README", () => {
    expect(findReadme(makeDir({ "README.markdown": "", "README.md": "" }))).toMatch(/README\.md$/);
    expect(findReadme(makeDir({ "README.markdown": "" }, ["README.md"]))).toMatch(
      /README\.markdown$/,
    );
  });

  it.runIf(caseSensitive)("picks README.md before readme.md, whatever the directory order", () => {
    expect(findReadme(makeDir({ "readme.md": "", "README.md": "", "Readme.md": "" }))).toMatch(
      /\/README\.md$/,
    );
  });

  it("checks anchors on directories with a README.markdown", () => {
    const root = makeDir({ "index.md": "" }, ["guide"]);
    writeFileSync(join(root, "guide", "README.markdown"), "# Guide\n\n## Setup\n");
    const context = { root };
    expect(checkLocalLink(join(root, "index.md"), "guide#setup", context)).toEqual({
      ok: true,
      status: 200,
    });
    expect(checkLocalLink(join(root, "index.md"), "guide/#nope", context)).toMatchObject({
      ok: false,
      error: "hash not found",
      errorDetail: "No heading matching #nope in guide/README.markdown",
    });
  });
});

describe("findMarkdownFiles()", () => {
  it("expands globs and file paths, sorted, deduplicated, markdown only, skipping node_modules", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local-files-test-"));
    for (const path of ["docs/b.md", "docs/a.markdown", "docs/c.txt", "node_modules/x/readme.md"]) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), "# x");
    }
    writeFileSync(join(dir, "README.md"), "# x");
    expect(await findMarkdownFiles(["**/*", "README.md", "docs/*.md"], dir)).toEqual([
      "README.md",
      "docs/a.markdown",
      "docs/b.md",
    ]);
    expect(await findMarkdownFiles(["nothing/**"], dir)).toEqual([]);
  });
});

describe("collectLinksFromFiles()", () => {
  it("groups links by kind, with the file as page", async () => {
    const collected = await collectLinksFromFiles({ patterns: ["README.md"], cwd: FIXTURE });
    expect(collected.files).toEqual(["README.md"]);
    expect(collected.external).toEqual([
      { page: "README.md", href: "https://example.com/page", text: "external", line: 19 },
    ]);
    expect(collected.skipped.map((link) => link.href)).toEqual(["mailto:hello@example.com"]);
    expect(collected.local).toHaveLength(14);
    expect(collected.local[0]).toEqual({
      page: "README.md",
      href: "docs/guide.md",
      text: "good file",
      line: 5,
    });
  });

  it("fails when no markdown file matches", async () => {
    await expect(collectLinksFromFiles({ patterns: ["nope/*.md"], cwd: FIXTURE })).rejects.toThrow(
      'No markdown files match "nope/*.md".',
    );
  });
});

describe("checkLocalFiles()", () => {
  beforeEach(() => {
    vi.mocked(checkLinks).mockClear();
  });

  it("checks local links on disk and external links with checkLinks", async () => {
    const report = await checkLocalFiles({ patterns: ["**/*.md"], cwd: FIXTURE, outputDir: false });
    expect(vi.mocked(checkLinks)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(checkLinks).mock.calls[0][0].links.map((link) => link.href)).toEqual([
      "https://example.com/page",
    ]);
    expect(report.siteName).toBe("local files");
    expect(report.summary).toMatchObject({
      linksChecked: 17,
      totalLinksToFix: 5,
      brokenLinks: 2,
      hashNotFound: 3,
      ignored: 0,
    });
    expect(report.brokenLinks.map((link) => `${link.page}:${link.line} ${link.href}`)).toEqual([
      "README.md:7 docs/missing.md",
      "docs/guide.md:8 ../nope.md",
    ]);
    expect(report.hashNotFound.map((link) => `${link.page}:${link.line} ${link.href}`)).toEqual([
      "README.md:8 docs/guide.md#nope",
      "README.md:10 #nowhere",
      "README.md:16 src/code.ts#L99",
    ]);
  });

  it("applies the baseline and skips checkLinks without external links", async () => {
    const report = await checkLocalFiles({
      patterns: ["docs/*.md"],
      cwd: FIXTURE,
      outputDir: false,
      baseline: createBaseline([{ href: "../nope.md", page: "docs/guide.md", reason: "known" }]),
    });
    expect(vi.mocked(checkLinks)).not.toHaveBeenCalled();
    expect(report.summary).toMatchObject({ linksChecked: 2, totalLinksToFix: 0, ignored: 1 });
    expect(report.ignored[0]).toMatchObject({ href: "../nope.md", ignoreReason: "known" });
  });
});
