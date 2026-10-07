import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkLinks } from "./link";
import {
  checkLocalFiles,
  checkLocalLink,
  collectLinksFromFiles,
  findMarkdownFiles,
  findReadme,
  getLinkKind,
} from "./local_files";
import type { LinkWithResult } from "./types";

vi.mock("./link", () => ({
  checkLinks: vi.fn(async ({ links }: { links: Array<{ href: string }> }) =>
    links.map((link) => ({ ...link, result: { ok: true, status: 200 } })),
  ),
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
    expect(check("README.md", "src/code.ts#L1").ok).toBe(true);
    expect(check("README.md", "src/code.ts#L2-L2").ok).toBe(true);
  });

  it.each(["#L0", "#L0-L2", "#L2-L0", "#L3-L2", "#L0C1"])(
    "rejects invalid line anchor %s",
    (hash) => {
      expect(check("README.md", `src/code.ts${hash}`)).toEqual({
        ok: false,
        error: "hash not found",
        status: 200,
        errorDetail: `Invalid line anchor ${hash} (lines start at 1, ranges go forward)`,
      });
      expect(check("README.md", "src/code.ts#something")).toMatchObject({
        ok: true,
        note: "Hash not checked (not a markdown file)",
      });
    },
  );

  it("accepts accidental hashes and text fragments", () => {
    expect(check("README.md", "docs/guide.md#/").ok).toBe(true);
    expect(check("README.md", "docs/guide.md#:~:text=Usage")).toMatchObject({
      ok: true,
      note: "Text Fragment",
    });
  });
});

describe("checkLocalLink() outside the repository", () => {
  const outside = (path: string) => ({
    ok: false,
    error: "broken link",
    errorDetail: `Link points outside the repository: ${path}`,
  });

  it("rejects relative and root-relative links leaving the root, even to existing files", () => {
    // Enough ../ to reach the filesystem root from the fixture, /etc/passwd exists on Linux runners
    const deep = `${"../".repeat(30)}etc/passwd`;
    expect(check("README.md", deep)).toEqual(outside(deep));
    expect(check("README.md", `${deep}#L1`)).toEqual(outside(deep));
    expect(check("docs/guide.md", "../../x.md")).toEqual(outside("../../x.md"));
    expect(check("README.md", "/../local.md")).toEqual(outside("/../local.md"));
    expect(check("README.md", "..")).toEqual(outside(".."));
  });

  it("accepts links to the root itself and inside it", () => {
    expect(check("docs/guide.md", "..").ok).toBe(true);
    expect(check("docs/guide.md", "../docs/../README.md").ok).toBe(true);
    expect(check("README.md", "/").ok).toBe(true);
  });

  it("rejects symlinks inside the root that point outside, accepts symlinks within it", () => {
    const secretDir = mkdtempSync(join(tmpdir(), "secret-"));
    writeFileSync(join(secretDir, "secret.md"), "# Secret heading\n");
    mkdirSync(join(secretDir, "dir"));
    writeFileSync(join(secretDir, "dir", "README.md"), "# Secret readme\n");

    const root = mkdtempSync(join(tmpdir(), "root-"));
    writeFileSync(join(root, "index.md"), "");
    writeFileSync(join(root, "real.md"), "# Real\n");
    symlinkSync(join(secretDir, "secret.md"), join(root, "leak.md"));
    symlinkSync(join(secretDir, "dir"), join(root, "leak-dir"));
    symlinkSync(join(root, "real.md"), join(root, "alias.md"));
    mkdirSync(join(root, "docs"));
    symlinkSync(join(secretDir, "dir", "README.md"), join(root, "docs", "README.md"));

    const context = { root };
    const from = join(root, "index.md");
    expect(checkLocalLink(from, "leak.md", context)).toEqual(outside("leak.md"));
    expect(checkLocalLink(from, "leak.md#secret-heading", context)).toEqual(outside("leak.md"));
    expect(checkLocalLink(from, "leak-dir/README.md", context)).toEqual(
      outside("leak-dir/README.md"),
    );
    // The directory is inside, but its README is a symlink to a file outside
    expect(checkLocalLink(from, "docs#secret-readme", context)).toEqual(outside("docs"));
    expect(checkLocalLink(from, "alias.md#real", context)).toEqual({ ok: true, status: 200 });
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

  const failing = (results: LinkWithResult[]) =>
    results
      .filter((link) => !link.result.ok)
      .map((link) => `${link.page}:${link.line} ${link.href}`)
      .toSorted();

  it("checks local links on disk and external links with checkLinks", async () => {
    const results = await checkLocalFiles({ patterns: ["**/*.md"], cwd: FIXTURE });
    expect(vi.mocked(checkLinks)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(checkLinks).mock.calls[0]![0].links.map((link) => link.href)).toEqual([
      "https://example.com/page",
    ]);
    expect(results).toHaveLength(17);
    expect(failing(results)).toEqual([
      "README.md:10 #nowhere",
      "README.md:16 src/code.ts#L99",
      "README.md:7 docs/missing.md",
      "README.md:8 docs/guide.md#nope",
      "docs/guide.md:8 ../nope.md",
    ]);
  });

  it("skips checkLinks without external links", async () => {
    const results = await checkLocalFiles({ patterns: ["docs/*.md"], cwd: FIXTURE });
    expect(vi.mocked(checkLinks)).not.toHaveBeenCalled();
    expect(results).toHaveLength(2);
    expect(failing(results)).toEqual(["docs/guide.md:8 ../nope.md"]);
  });
});
