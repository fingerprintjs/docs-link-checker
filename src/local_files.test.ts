import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { checkLocalFiles, checkLocalLink, collectLinksFromFiles } from "./local_files";
import type { LinkWithResult } from "./types";

// Avoids network access, the external link only needs to come back with a result
vi.mock("./link", () => ({
  checkLinks: vi.fn(async ({ links }: { links: Array<{ href: string }> }) =>
    links.map((link) => ({ ...link, result: { ok: true, status: 200 } })),
  ),
}));

const FIXTURE = resolve(import.meta.dirname, "__fixtures__/local");
const check = (file: string, href: string) =>
  checkLocalLink(join(FIXTURE, file), href, { root: FIXTURE });

const makeTempDir = (files: Record<string, string> = {}, dirs: string[] = []) => {
  const dir = mkdtempSync(join(tmpdir(), "local-files-test-"));
  for (const name of dirs) mkdirSync(join(dir, name), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
};

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

  // Line range rules are covered in line_anchor.test.ts, this checks the wiring to code files
  it("checks GitHub line anchors on code files, ignores other anchors", () => {
    expect(check("README.md", "src/code.ts#L2-L3").ok).toBe(true);
    expect(check("README.md", "src/code.ts#L4")).toMatchObject({
      error: "hash not found",
      errorDetail: "src/code.ts has only 3 lines",
    });
    expect(check("README.md", "src/code.ts#L0").ok).toBe(false);
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

describe("README of a directory anchor", () => {
  // Each README has its own heading, so the anchor shows which one was picked
  const picked = (files: Record<string, string>, dirs: string[] = []) => {
    const root = makeTempDir({ "index.md": "", ...files }, ["dir", ...dirs]);
    const from = join(root, "index.md");
    return (heading: string) => checkLocalLink(from, `dir#${heading}`, { root }).ok;
  };
  const readme = (name: string, heading: string) => ({ [`dir/${name}`]: `# ${heading}\n` });
  // Case-insensitive filesystems (macOS, Windows) can't have README.md and readme.md side by side
  const caseSensitive = (() => {
    const dir = makeTempDir({ a: "" });
    return !existsSync(join(dir, "A"));
  })();

  it("finds README.markdown and lowercase or mixed-case names", () => {
    expect(picked(readme("README.markdown", "found"))("found")).toBe(true);
    expect(picked(readme("readme.md", "found"))("found")).toBe(true);
    expect(picked(readme("Readme.Markdown", "found"))("found")).toBe(true);
  });

  it("does not check the hash of a directory without a README", () => {
    const root = makeTempDir({ "index.md": "", "dir/README.txt": "", "dir/notes.md": "# x" });
    expect(checkLocalLink(join(root, "index.md"), "dir#x", { root })).toMatchObject({
      ok: true,
      note: "Hash not checked (directory without README)",
    });
  });

  it("prefers .md over .markdown and ignores directories named like a README", () => {
    const both = picked({
      ...readme("README.markdown", "markdown-ext"),
      ...readme("README.md", "md-ext"),
    });
    expect(both("md-ext")).toBe(true);
    expect(both("markdown-ext")).toBe(false);

    const withDir = picked(readme("README.markdown", "found"), ["dir/README.md"]);
    expect(withDir("found")).toBe(true);
  });

  it.runIf(caseSensitive)("picks README.md before readme.md, whatever the directory order", () => {
    const pick = picked({
      ...readme("readme.md", "lower"),
      ...readme("README.md", "upper"),
      ...readme("Readme.md", "mixed"),
    });
    expect(pick("upper")).toBe(true);
    expect(pick("lower")).toBe(false);
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
    const localHrefs = collected.local.map((link) => link.href);
    expect(localHrefs).toContain("docs/missing.md");
    // Links in code blocks are not extracted
    expect(localHrefs).not.toContain("docs/not-checked.md");
    expect(collected.local[0]).toEqual({
      page: "README.md",
      href: "docs/guide.md",
      text: "good file",
      line: 5,
    });
  });

  it("classifies hrefs and checks protocol-relative links over https", async () => {
    const cwd = makeTempDir({
      "links.md": [
        "[a](https://example.com)",
        "[b](HTTP://example.com)",
        "[c](//cdn.example.com/x)",
        "[d](mailto:a@b.c)",
        "[e](tel:+123)",
        "[f](data:text/plain,x)",
        "[g](docs/a.md)",
        "[h](./a.md)",
        "[i](../a.md)",
        "[j](/docs/a.md)",
        "[k](#anchor)",
        "[l](a.md?x=1:2)",
      ].join("\n\n"),
    });
    const collected = await collectLinksFromFiles({ patterns: ["links.md"], cwd });
    const hrefs = (links: Array<{ href: string }>) => links.map((link) => link.href);
    expect(hrefs(collected.external)).toEqual([
      "https://example.com",
      "HTTP://example.com",
      "https://cdn.example.com/x",
    ]);
    expect(hrefs(collected.skipped)).toEqual(["mailto:a@b.c", "tel:+123", "data:text/plain,x"]);
    expect(hrefs(collected.local)).toEqual([
      "docs/a.md",
      "./a.md",
      "../a.md",
      "/docs/a.md",
      "#anchor",
      "a.md?x=1:2",
    ]);
  });

  it("expands globs and file paths, sorted, deduplicated, markdown only, skipping node_modules", async () => {
    const cwd = makeTempDir({
      "docs/b.md": "# x",
      "docs/a.markdown": "# x",
      "docs/c.txt": "# x",
      "node_modules/x/readme.md": "# x",
      "README.md": "# x",
    });
    const { files } = await collectLinksFromFiles({
      patterns: ["**/*", "README.md", "docs/*.md"],
      cwd,
    });
    expect(files).toEqual(["README.md", "docs/a.markdown", "docs/b.md"]);
  });

  it("fails when no markdown file matches", async () => {
    await expect(collectLinksFromFiles({ patterns: ["nope/*.md"], cwd: FIXTURE })).rejects.toThrow(
      'No markdown files match "nope/*.md".',
    );
  });
});

describe("checkLocalFiles()", () => {
  const failing = (results: LinkWithResult[]) =>
    results
      .filter((link) => !link.result.ok)
      .map((link) => `${link.page}:${link.line} ${link.href}`)
      .toSorted();

  it("checks local links on disk and includes the results of external links", async () => {
    const results = await checkLocalFiles({ patterns: ["**/*.md"], cwd: FIXTURE });
    expect(results.find((link) => link.href === "https://example.com/page")?.result.ok).toBe(true);
    expect(failing(results)).toEqual([
      "README.md:10 #nowhere",
      "README.md:16 src/code.ts#L99",
      "README.md:7 docs/missing.md",
      "README.md:8 docs/guide.md#nope",
      "docs/guide.md:8 ../nope.md",
    ]);
  });
});
