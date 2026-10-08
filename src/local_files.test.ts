import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FileSystem } from "@effect/platform";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import { it } from "@effect/vitest";
import { Effect, Logger, LogLevel } from "effect";
import { describe, expect } from "vitest";
import { NoMarkdownFiles } from "./errors";
import { checkLocalFiles, checkLocalLink, collectLinksFromFiles } from "./local_files";
import { getMarkdownAnchors } from "./markdown";
import { fakeFetch } from "./test/fake_fetch";
import { testRunLayer } from "./test/layers";
import type { LinkWithResult } from "./types";

const FIXTURE = resolve(import.meta.dirname, "__fixtures__/local");

const checkIn = (root: string, file: string, href: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    checkLocalLink(join(root, file), href, {
      root,
      anchorsOf: (path) => fs.readFileString(path).pipe(Effect.map(getMarkdownAnchors)),
    }),
  );

const check = (file: string, href: string) => checkIn(FIXTURE, file, href);

/** Runs with the real file system, the tests use fixtures and temp directories */
const withFs = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  effect.pipe(Effect.provide(NodeFileSystem.layer));

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
  it.effect(
    "accepts existing files and directories (relative, root-relative, encoded, with a query string)",
    () =>
      withFs(
        Effect.gen(function* () {
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
            expect(yield* check("README.md", href), href).toEqual({ ok: true, status: 200 });
          }
          expect(yield* check("docs/guide.md", "../README.md")).toEqual({ ok: true, status: 200 });
        }),
      ),
  );

  it.effect("reports missing files as broken links, relative to the root", () =>
    withFs(
      Effect.gen(function* () {
        expect(yield* check("README.md", "docs/missing.md")).toEqual({
          ok: false,
          error: "broken link",
          errorDetail: "File not found: docs/missing.md",
        });
        expect(yield* check("docs/guide.md", "../nope.md#x")).toMatchObject({
          error: "broken link",
          errorDetail: "File not found: nope.md",
        });
        expect(yield* check("docs/guide.md", "guide.md/extra")).toMatchObject({
          error: "broken link",
        });
      }),
    ),
  );

  it.effect("checks anchors against headings of markdown files", () =>
    withFs(
      Effect.gen(function* () {
        expect(yield* check("README.md", "docs/guide.md#installation")).toEqual({
          ok: true,
          status: 200,
        });
        expect((yield* check("README.md", "docs/guide.md?plain=1#installation")).ok).toBe(true);
        expect((yield* check("README.md", "docs/guide.md#Installation")).ok).toBe(true);
        expect((yield* check("README.md", "#getting-started")).ok).toBe(true);
        expect((yield* check("docs/guide.md", "../README.md#getting-started")).ok).toBe(true);
        expect(yield* check("README.md", "docs/guide.md#nope")).toEqual({
          ok: false,
          error: "hash not found",
          status: 200,
          errorDetail: "No heading matching #nope in docs/guide.md",
        });
        expect(yield* check("README.md", "#nowhere")).toMatchObject({
          error: "hash not found",
          errorDetail: "No heading matching #nowhere in README.md",
        });
      }),
    ),
  );

  it.effect("checks anchors on directories against their README", () =>
    withFs(
      Effect.gen(function* () {
        expect((yield* check("README.md", "docs#docs-index")).ok).toBe(true);
        expect(yield* check("README.md", "docs/#nope")).toMatchObject({
          error: "hash not found",
          errorDetail: "No heading matching #nope in docs/README.md",
        });
        expect(yield* check("README.md", "src#anything")).toMatchObject({
          ok: true,
          note: "Hash not checked (directory without README)",
        });
      }),
    ),
  );

  // Line range rules are covered in line_anchor.test.ts, this checks the wiring to code files
  it.effect("checks GitHub line anchors on code files, ignores other anchors", () =>
    withFs(
      Effect.gen(function* () {
        expect((yield* check("README.md", "src/code.ts#L2-L3")).ok).toBe(true);
        expect(yield* check("README.md", "src/code.ts#L4")).toMatchObject({
          error: "hash not found",
          errorDetail: "src/code.ts has only 3 lines",
        });
        expect((yield* check("README.md", "src/code.ts#L0")).ok).toBe(false);
        expect(yield* check("README.md", "src/code.ts#something")).toMatchObject({
          ok: true,
          note: "Hash not checked (not a markdown file)",
        });
      }),
    ),
  );

  it.effect("accepts accidental hashes and text fragments", () =>
    withFs(
      Effect.gen(function* () {
        expect((yield* check("README.md", "docs/guide.md#/")).ok).toBe(true);
        expect(yield* check("README.md", "docs/guide.md#:~:text=Usage")).toMatchObject({
          ok: true,
          note: "Text Fragment",
        });
      }),
    ),
  );
});

describe("checkLocalLink() outside the repository", () => {
  const outside = (path: string) => ({
    ok: false,
    error: "broken link",
    errorDetail: `Link points outside the repository: ${path}`,
  });

  it.effect(
    "rejects relative and root-relative links leaving the root, even to existing files",
    () =>
      withFs(
        Effect.gen(function* () {
          // Enough ../ to reach the filesystem root from the fixture, /etc/passwd exists on Linux runners
          const deep = `${"../".repeat(30)}etc/passwd`;
          expect(yield* check("README.md", deep)).toEqual(outside(deep));
          expect(yield* check("README.md", `${deep}#L1`)).toEqual(outside(deep));
          expect(yield* check("docs/guide.md", "../../x.md")).toEqual(outside("../../x.md"));
          expect(yield* check("README.md", "/../local.md")).toEqual(outside("/../local.md"));
          expect(yield* check("README.md", "..")).toEqual(outside(".."));
        }),
      ),
  );

  it.effect("accepts links to the root itself and inside it", () =>
    withFs(
      Effect.gen(function* () {
        expect((yield* check("docs/guide.md", "..")).ok).toBe(true);
        expect((yield* check("docs/guide.md", "../docs/../README.md")).ok).toBe(true);
        expect((yield* check("README.md", "/")).ok).toBe(true);
      }),
    ),
  );

  it.effect(
    "rejects symlinks inside the root that point outside, accepts symlinks within it",
    () => {
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

      return withFs(
        Effect.gen(function* () {
          expect(yield* checkIn(root, "index.md", "leak.md")).toEqual(outside("leak.md"));
          expect(yield* checkIn(root, "index.md", "leak.md#secret-heading")).toEqual(
            outside("leak.md"),
          );
          expect(yield* checkIn(root, "index.md", "leak-dir/README.md")).toEqual(
            outside("leak-dir/README.md"),
          );
          // The directory is inside, but its README is a symlink to a file outside
          expect(yield* checkIn(root, "index.md", "docs#secret-readme")).toEqual(outside("docs"));
          expect(yield* checkIn(root, "index.md", "alias.md#real")).toEqual({
            ok: true,
            status: 200,
          });
        }),
      );
    },
  );
});

describe("README of a directory anchor", () => {
  // Each README has its own heading, so the anchor shows which one was picked
  const picked = (files: Record<string, string>, dirs: string[] = []) => {
    const root = makeTempDir({ "index.md": "", ...files }, ["dir", ...dirs]);
    return (heading: string) =>
      checkIn(root, "index.md", `dir#${heading}`).pipe(Effect.map((result) => result.ok));
  };
  const readme = (name: string, heading: string) => ({ [`dir/${name}`]: `# ${heading}\n` });
  // Case-insensitive filesystems (macOS, Windows) can't have README.md and readme.md side by side
  const caseSensitive = (() => {
    const dir = makeTempDir({ a: "" });
    return !existsSync(join(dir, "A"));
  })();

  it.effect("finds README.markdown and lowercase or mixed-case names", () =>
    withFs(
      Effect.gen(function* () {
        expect(yield* picked(readme("README.markdown", "found"))("found")).toBe(true);
        expect(yield* picked(readme("readme.md", "found"))("found")).toBe(true);
        expect(yield* picked(readme("Readme.Markdown", "found"))("found")).toBe(true);
      }),
    ),
  );

  it.effect("does not check the hash of a directory without a README", () => {
    const root = makeTempDir({ "index.md": "", "dir/README.txt": "", "dir/notes.md": "# x" });
    return withFs(
      Effect.gen(function* () {
        expect(yield* checkIn(root, "index.md", "dir#x")).toMatchObject({
          ok: true,
          note: "Hash not checked (directory without README)",
        });
      }),
    );
  });

  it.effect("prefers .md over .markdown and ignores directories named like a README", () =>
    withFs(
      Effect.gen(function* () {
        const both = picked({
          ...readme("README.markdown", "markdown-ext"),
          ...readme("README.md", "md-ext"),
        });
        expect(yield* both("md-ext")).toBe(true);
        expect(yield* both("markdown-ext")).toBe(false);

        const withDir = picked(readme("README.markdown", "found"), ["dir/README.md"]);
        expect(yield* withDir("found")).toBe(true);
      }),
    ),
  );

  if (caseSensitive) {
    it.effect("picks README.md before readme.md, whatever the directory order", () =>
      withFs(
        Effect.gen(function* () {
          const pick = picked({
            ...readme("readme.md", "lower"),
            ...readme("README.md", "upper"),
            ...readme("Readme.md", "mixed"),
          });
          expect(yield* pick("upper")).toBe(true);
          expect(yield* pick("lower")).toBe(false);
        }),
      ),
    );
  }
});

describe("collectLinksFromFiles()", () => {
  it.effect("groups links by kind, with the file as page", () =>
    withFs(
      Effect.gen(function* () {
        const collected = yield* collectLinksFromFiles({
          patterns: ["README.md"],
          cwd: FIXTURE,
          sampleRate: 1,
        });
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
      }),
    ),
  );

  it.effect("classifies hrefs and checks protocol-relative links over https", () => {
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
    return withFs(
      Effect.gen(function* () {
        const collected = yield* collectLinksFromFiles({
          patterns: ["links.md"],
          cwd,
          sampleRate: 1,
        });
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
      }),
    );
  });

  it.effect(
    "expands globs and file paths, sorted, deduplicated, markdown only, skipping node_modules",
    () => {
      const cwd = makeTempDir({
        "docs/b.md": "# x",
        "docs/a.markdown": "# x",
        "docs/c.txt": "# x",
        "node_modules/x/readme.md": "# x",
        "README.md": "# x",
      });
      return withFs(
        Effect.gen(function* () {
          const { files } = yield* collectLinksFromFiles({
            patterns: ["**/*", "README.md", "docs/*.md"],
            cwd,
            sampleRate: 1,
          });
          expect(files).toEqual(["README.md", "docs/a.markdown", "docs/b.md"]);
        }),
      );
    },
  );

  it.effect("checks a sample of the files with a sample rate below 1", () => {
    const cwd = makeTempDir(
      Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}.md`, "# x"])),
    );
    return withFs(
      Effect.gen(function* () {
        const { files } = yield* collectLinksFromFiles({
          patterns: ["*.md"],
          cwd,
          sampleRate: 0.2,
        });
        expect(files).toEqual(["f0.md", "f5.md"]);
      }).pipe(Effect.provide(Logger.minimumLogLevel(LogLevel.None))),
    );
  });

  it.effect("fails when no markdown file matches", () =>
    withFs(
      Effect.gen(function* () {
        const error = yield* collectLinksFromFiles({
          patterns: ["nope/*.md"],
          cwd: FIXTURE,
          sampleRate: 1,
        }).pipe(Effect.flip);
        expect(error).toBeInstanceOf(NoMarkdownFiles);
        expect(error.message).toBe('No markdown files match "nope/*.md".');
      }),
    ),
  );
});

describe("checkLocalFiles()", () => {
  const failing = (results: LinkWithResult[]) =>
    results
      .filter((link) => !link.result.ok)
      .map((link) => `${link.page}:${link.line} ${link.href}`)
      .toSorted();

  it.effect("checks local links on disk and includes the results of external links", () =>
    // The external link only needs to come back with a result
    Effect.gen(function* () {
      const results = yield* checkLocalFiles({
        patterns: ["**/*.md"],
        cwd: FIXTURE,
        sampleRate: 1,
      });
      expect(results.find((link) => link.href === "https://example.com/page")?.result.ok).toBe(
        true,
      );
      expect(failing(results)).toEqual([
        "README.md:10 #nowhere",
        "README.md:16 src/code.ts#L99",
        "README.md:7 docs/missing.md",
        "README.md:8 docs/guide.md#nope",
        "docs/guide.md:8 ../nope.md",
      ]);
    }).pipe(
      Effect.provide(testRunLayer({ fetch: fakeFetch(() => new Response("ok")).layer })),
      Effect.provide(NodeFileSystem.layer),
      Effect.provide(Logger.minimumLogLevel(LogLevel.None)),
    ),
  );
});
