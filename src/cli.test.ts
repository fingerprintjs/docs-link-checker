import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import { it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import { describe, expect, vi } from "vitest";
import { formatFileProblems, runCli, runCliEffect } from "./cli";
import { GitHubApiError } from "./errors";
import type { GitHubApi } from "./github/github_client";
import { getJSONReport } from "./report/report";
import { fakeFetch, type FetchHandler } from "./test/fake_fetch";
import { fakeGitHub } from "./test/fake_github";
import { testRunLayer } from "./test/layers";
import { makeTestConsole } from "./test/test_console";

/**
 * End to end tests of the commands over the real pipeline: real files in temp dirs (`files`), a fake `fetch`
 * (`site`, link checks) and a fake `GitHub` (`github-org`).
 */

const tempDir = () => mkdtempSync(join(tmpdir(), "cli-test-"));

const GUIDE = [
  "# Guide",
  "",
  "Some text.",
  "",
  "",
  "",
  "[Readme](../README.md#getting-started)",
  "[Missing](../nope.md)",
  "",
].join("\n");

/** Temp dir with a README and a guide that links to it (line 7, works) and to a missing file (line 8) */
const project = (files: Record<string, string> = {}) => {
  const dir = tempDir();
  for (const [name, content] of Object.entries({
    "README.md": "# Getting started\n",
    "docs/guide.md": GUIDE,
    ...files,
  })) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
};
const BROKEN_LINE = "docs/guide.md:8: ../nope.md: broken link: File not found: nope.md";
const ANNOTATION =
  "::error file=docs/guide.md,line=8,title=Broken link::../nope.md: broken link: File not found: nope.md";

describe("formatFileProblems()", () => {
  it("prints one line per link to fix, collapsing and shortening error details", () => {
    const report = getJSONReport({
      siteName: "local files",
      links: [
        {
          page: "a.md",
          line: 3,
          href: "https://x.com",
          text: "",
          result: { ok: false, error: "unexpected error", errorDetail: `boom\n${"x".repeat(300)}` },
        },
        { page: "b.md", href: "c.md", text: "", result: { ok: false, error: "broken link" } },
      ],
    });
    // Report order: broken links first, then unexpected errors
    const [first, second] = formatFileProblems(report);
    expect(first).toBe("b.md: c.md: broken link");
    expect(second?.startsWith("a.md:3: https://x.com: unexpected error: boom xxx")).toBe(true);
    expect(second).not.toContain("\n");
    expect(second?.endsWith("…")).toBe(true);
  });
});

type RunOptions = {
  readonly env?: Record<string, string>;
  readonly cwd?: string;
  readonly fetch?: FetchHandler;
  readonly github?: Partial<GitHubApi>;
};

/** Runs the CLI with a fake environment and captured output */
const run = (args: string[], { env = {}, cwd = project(), fetch, github }: RunOptions = {}) => {
  const testConsole = makeTestConsole();
  const runLayer = () =>
    testRunLayer({
      fetch: fetch ? fakeFetch(fetch).layer : undefined,
      github: github ? fakeGitHub(github).layer : undefined,
    });
  return runCliEffect(args, { cwd, runLayer }).pipe(
    Effect.withConfigProvider(ConfigProvider.fromMap(new Map(Object.entries(env)))),
    Effect.withConsole(testConsole.console),
    Effect.provide(NodeFileSystem.layer),
    Effect.map((code) => ({ code, stdout: testConsole.stdout, stderr: testConsole.stderr })),
  );
};

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

describe("runCliEffect()", () => {
  describe("arguments and options", () => {
    // Ten files, a sample of them is checked: the sampling log says with which rate
    const manyFiles = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`pages/p${i}.md`, "text\n"]),
    );
    const dryRun = (args: string[], env: Record<string, string> = {}) =>
      run(["files", "pages/*.md", "--dry-run", ...args], { env, cwd: project(manyFiles) }).pipe(
        Effect.map(({ code, stdout, stderr }) => {
          expect(stderr).toEqual([]);
          expect(code).toBe(0);
          const rate = /sample rate ([\d.]+)/.exec(stdout.join("\n"))?.[1];
          return rate === undefined ? 1 : Number(rate);
        }),
      );

    it.effect(
      "--sample-rate sets the sample rate, LINK_CHECK_SAMPLE_RATE is the default and flags win",
      () =>
        Effect.gen(function* () {
          const env = { LINK_CHECK_SAMPLE_RATE: "0.1" };
          expect(yield* dryRun([])).toBe(1);
          expect(yield* dryRun(["--sample-rate", "0.5"])).toBe(0.5);
          expect(yield* dryRun([], env)).toBe(0.1);
          expect(yield* dryRun(["--sample-rate=1"], env)).toBe(1);
          // Empty means unset
          expect(yield* dryRun([], { LINK_CHECK_SAMPLE_RATE: " " })).toBe(1);
        }),
    );

    it.effect("--host-concurrency and LINK_CHECK_HOST_CONCURRENCY set the run settings", () =>
      Effect.gen(function* () {
        const concurrencies: number[] = [];
        const runWith = (args: string[], env: Record<string, string> = {}) =>
          runCliEffect(["files", "a.md", "--output-dir", tempDir(), ...args], {
            cwd: project({ "a.md": "text\n" }),
            runLayer: ({ hostConcurrency }) => {
              concurrencies.push(hostConcurrency);
              return testRunLayer();
            },
          }).pipe(
            Effect.withConfigProvider(ConfigProvider.fromMap(new Map(Object.entries(env)))),
            Effect.withConsole(makeTestConsole().console),
            Effect.provide(NodeFileSystem.layer),
          );
        yield* runWith([]);
        yield* runWith(["--host-concurrency", "3"]);
        yield* runWith([], { LINK_CHECK_HOST_CONCURRENCY: "5" });
        expect(concurrencies).toEqual([8, 3, 5]);
      }),
    );

    it.effect("FAIL_ON_BROKEN_LINKS=false and --no-fail-on-broken only report links to fix", () =>
      Effect.gen(function* () {
        const outputDir = tempDir();
        const cwd = project();
        const exitCode = (args: string[], env: Record<string, string> = {}) =>
          run(["files", "docs/*.md", "--output-dir", outputDir, ...args], { env, cwd }).pipe(
            Effect.map(({ code }) => code),
          );
        expect(yield* exitCode([])).toBe(1);
        expect(yield* exitCode([], { FAIL_ON_BROKEN_LINKS: "true" })).toBe(1);
        expect(yield* exitCode([], { FAIL_ON_BROKEN_LINKS: "false" })).toBe(0);
        expect(yield* exitCode(["--no-fail-on-broken"])).toBe(0);
        expect(yield* exitCode(["--fail-on-broken"], { FAIL_ON_BROKEN_LINKS: "false" })).toBe(1);
      }),
    );

    it.effect("LINK_CHECK_BASELINE is the default baseline file", () => {
      const baselinePath = join(tempDir(), "env.json");
      writeFileSync(baselinePath, JSON.stringify({ ignore: [{ href: "../nope.md" }] }));
      const outputDir = tempDir();
      return run(["files", "docs/*.md", "--output-dir", outputDir], {
        env: { LINK_CHECK_BASELINE: baselinePath },
      }).pipe(
        Effect.tap(({ code }) => {
          expect(code).toBe(0);
          expect(readJson(join(outputDir, "local-files.json"))).toMatchObject({
            summary: { totalLinksToFix: 0, ignored: 1 },
          });
        }),
      );
    });

    it.effect(
      "--update-baseline writes the default baseline file and reads a relative --baseline in cwd, not process.cwd()",
      () =>
        Effect.gen(function* () {
          const cwd = project();
          const outputDir = tempDir();
          const runInCwd = (args: string[]) =>
            run(["files", "docs/*.md", "--output-dir", outputDir, ...args], { cwd }).pipe(
              Effect.map(({ code }) => code),
            );

          expect(yield* runInCwd(["--update-baseline"])).toBe(0);
          expect(readJson(join(cwd, "linkcheck.baseline.json"))).toEqual({
            ignore: [{ href: "../nope.md", page: "docs/guide.md" }],
          });
          // The baseline is found again by its relative path and covers the broken link
          expect(yield* runInCwd(["--baseline", "linkcheck.baseline.json"])).toBe(0);
        }),
    );

    const usageErrors: Array<[string[], string]> = [
      [[], "Usage: docs-link-checker"],
      [["nope"], "unknown command 'nope'"],
      [["files"], "missing required argument"],
      [["site"], "missing required argument"],
      [["site", "a", "b"], "too many arguments"],
      [["site", "not a url"], 'Invalid URL "not a url"'],
      [["site", "file:///etc/passwd"], "expected an http(s) URL"],
      [["site", "https://a.com", "--include="], "must not be empty"],
      [["github-org"], "missing required argument"],
      [["github-org", "../x"], 'Invalid GitHub organization "../x".'],
      [["files", "a.md", "--include", "x"], "unknown option '--include'"],
      [["site", "https://a.com", "--dry-run"], "unknown option '--dry-run'"],
      [["github-org", "x", "--no-annotations"], "unknown option '--no-annotations'"],
      [["files", "a.md", "--sample-rate", "2"], 'Invalid --sample-rate "2"'],
      [["files", "a.md", "--sample-rate="], "must not be empty"],
      [["files", "a.md", "--host-concurrency", "0"], 'Invalid --host-concurrency "0"'],
      [["files", "a.md", "--baseline"], "argument missing"],
      [
        ["files", "a.md", "--prune-baseline"],
        "--prune-baseline can only be used with --update-baseline.",
      ],
      [
        ["files", "a.md", "--update-baseline", "--prune-baseline", "--sample-rate", "0.5"],
        "--prune-baseline needs a full run",
      ],
    ];
    it.effect.each(usageErrors)("rejects %j with exit code 2", ([args, message]) =>
      Effect.gen(function* () {
        const { code, stdout, stderr } = yield* run(args);

        expect(code).toBe(2);
        expect(stderr.join("\n")).toContain(message);
        // Nothing was checked
        expect(stdout.join("\n")).not.toContain("Checking");
      }),
    );

    it.effect("prints usage errors as a message and a hint to stderr only", () =>
      run(["files", "a.md", "--update-baseline", "--prune-baseline", "--sample-rate", "0.5"]).pipe(
        Effect.tap(({ stdout, stderr }) => {
          expect(stdout).toEqual([]);
          expect(stderr).toEqual([
            `Error: --prune-baseline needs a full run (sample rate 1), entries of pages that were not checked would be removed.\nRun "docs-link-checker --help" for usage.`,
          ]);
        }),
      ),
    );

    const badEnv = {
      LINK_CHECK_SAMPLE_RATE: "abc",
      LINK_CHECK_HOST_CONCURRENCY: "-1",
    };

    it.effect("rejects invalid environment variables when they are used (exit code 2)", () =>
      Effect.gen(function* () {
        for (const [name, value] of Object.entries(badEnv)) {
          const { code, stderr } = yield* run(["files", "a.md"], { env: { [name]: value } });
          expect(code).toBe(2);
          expect(stderr.join("\n")).toContain(`Invalid ${name} "${value}"`);
        }
      }),
    );

    it.effect(
      "ignores invalid environment variables for --help and for flags that override them",
      () =>
        Effect.gen(function* () {
          expect((yield* run(["--help"], { env: badEnv })).code).toBe(0);
          expect((yield* run(["site", "--help"], { env: badEnv })).code).toBe(0);
          const sampleRate = yield* dryRun(
            ["--sample-rate", "0.5", "--host-concurrency", "3"],
            badEnv,
          );
          expect(sampleRate).toBe(0.5);
        }),
    );

    it.effect("prints help for help, --help and <command> --help to stdout", () =>
      Effect.gen(function* () {
        for (const args of [["--help"], ["help"], ["files", "-h"], ["help", "site"]]) {
          const { code, stdout, stderr } = yield* run(args);
          expect(code).toBe(0);
          expect(stdout.join("\n")).toContain("Usage: docs-link-checker");
          expect(stderr).toEqual([]);
        }
      }),
    );

    it.effect("describes the options and environment variables of a command in its help", () =>
      Effect.gen(function* () {
        const { stdout } = yield* run(["site", "--help"]);

        expect(stdout.join("\n")).toContain("--include <prefix>");
        expect(stdout.join("\n")).toContain("LINK_CHECK_SAMPLE_RATE");
      }),
    );
  });

  describe("files", () => {
    it.effect("prints problems, writes reports and outputs, fails on links to fix", () => {
      const out = tempDir();
      const githubOutput = join(out, "github-output");
      const summary = join(out, "summary.md");
      writeFileSync(githubOutput, "");
      return run(["files", "docs/*.md", "README.md", "--output-dir", out], {
        env: { GITHUB_OUTPUT: githubOutput, GITHUB_STEP_SUMMARY: summary },
      }).pipe(
        Effect.tap(({ code, stdout }) => {
          expect(code).toBe(1);
          expect(stdout).toContain(BROKEN_LINE);
          expect(stdout).toContain(`Saved JSON report to ${join(out, "local-files.json")}`);
          expect(readFileSync(githubOutput, "utf8")).toBe(
            `links-to-fix=1\nreport-path=${join(out, "local-files.json")}\nreport-html-path=${join(out, "local-files.html")}\n`,
          );
          expect(readFileSync(summary, "utf8")).toContain("| docs/guide.md:8 | ../nope.md |");
          expect(readJson(join(out, "local-files.json"))).toMatchObject({
            summary: { linksChecked: 2, totalLinksToFix: 1 },
          });
          expect(existsSync(join(out, "local-files.html"))).toBe(true);
        }),
      );
    });

    it.effect("checks external links over the network", () => {
      const cwd = project({
        "docs/guide.md": "[A](https://ok.example/a)\n[B](https://ok.example/b)\n",
      });
      return run(["files", "docs/*.md", "--output-dir", tempDir()], {
        cwd,
        fetch: (url) => new Response("", { status: url.endsWith("/a") ? 200 : 404 }),
      }).pipe(
        Effect.tap(({ code, stdout }) => {
          expect(code).toBe(1);
          expect(stdout).toContain("docs/guide.md:2: https://ok.example/b: broken link (404)");
        }),
      );
    });

    it.effect("logs the summary, the duration and, last, the run metrics", () =>
      run(["files", "docs/*.md", "--output-dir", tempDir(), "--no-fail-on-broken"]).pipe(
        Effect.tap(({ stdout }) => {
          const text = stdout.join("\n");
          expect(text).toContain("linksChecked: 2");
          expect(text).toMatch(/Finished in [\d.]+ seconds\./);
          expect(text.indexOf("Finished in")).toBeLessThan(text.indexOf("Run metrics:"));
        }),
      ),
    );

    it.effect("emits annotations in GitHub Actions, and passes with --no-fail-on-broken", () =>
      Effect.gen(function* () {
        const env = { GITHUB_ACTIONS: "true" };
        const cwd = project();
        const args = ["files", "docs/*.md", "--output-dir", tempDir(), "--no-fail-on-broken"];
        const annotated = yield* run(args, { env, cwd });
        expect(annotated.code).toBe(0);
        expect(annotated.stdout).toContain(ANNOTATION);

        const quiet = yield* run([...args, "--no-annotations"], { env, cwd });
        expect(quiet.stdout.filter((line) => line.startsWith("::"))).toEqual([]);
        expect(quiet.stdout.filter((line) => line.includes("nope.md"))).toEqual([]);
      }),
    );

    it.effect(
      "links local files to the checked commit in the HTML report in GitHub Actions",
      () => {
        const out = tempDir();
        const cwd = project();
        const sha = "0123456789abcdef0123456789abcdef01234567";
        return run(["files", "docs/*.md", "--output-dir", out, "--no-fail-on-broken"], {
          cwd,
          env: {
            GITHUB_ACTIONS: "true",
            GITHUB_WORKSPACE: cwd,
            GITHUB_REPOSITORY: "owner/repo",
            GITHUB_SHA: sha,
            GITHUB_SERVER_URL: "https://github.com",
          },
        }).pipe(
          Effect.tap(() => {
            const html = readFileSync(join(out, "local-files.html"), "utf8");
            expect(html).toContain(
              `href="https://github.com/owner/repo/blob/${sha}/docs/guide.md#L8"`,
            );
            expect(html).toContain(`href="https://github.com/owner/repo/blob/${sha}/nope.md"`);
          }),
        );
      },
    );

    it.effect("--json prints only the JSON report to stdout, logs and annotations to stderr", () =>
      run(["files", "docs/*.md", "--output-dir", tempDir(), "--json", "--no-fail-on-broken"], {
        env: { GITHUB_ACTIONS: "true" },
      }).pipe(
        Effect.tap(({ code, stdout, stderr }) => {
          expect(code).toBe(0);
          expect(stdout).toHaveLength(1);
          expect(JSON.parse(stdout[0] ?? "")).toMatchObject({
            summary: { linksChecked: 2, totalLinksToFix: 1 },
          });
          expect(stderr).toContain(ANNOTATION);
          expect(stderr.some((line) => line.startsWith("Saved JSON report to"))).toBe(true);
          expect(stderr.some((line) => line.startsWith("Run metrics:"))).toBe(true);
        }),
      ),
    );

    // Lines 7, 18 and 19 of the README
    const readme = [..."123456".split("").map(() => ""), "[Missing](docs/missing.md)"]
      .concat(Array.from({ length: 10 }, () => ""))
      .concat([
        "[Mail](mailto:hello@example.com)",
        "[Page](https://example.com/page)",
        "[Top](#top)",
        "",
      ])
      .join("\n");

    it.effect("--dry-run lists links without checking them", () => {
      const githubOutput = join(tempDir(), "github-output");
      writeFileSync(githubOutput, "");
      return run(["files", "README.md", "--dry-run"], {
        cwd: project({ "README.md": readme }),
        env: { GITHUB_OUTPUT: githubOutput },
      }).pipe(
        Effect.tap(({ code, stdout }) => {
          expect(code).toBe(0);
          expect(stdout).toEqual([
            "local\tREADME.md:7\tdocs/missing.md",
            "local\tREADME.md:20\t#top",
            "external\tREADME.md:19\thttps://example.com/page",
            "skipped\tREADME.md:18\tmailto:hello@example.com",
            "1 files, 2 local, 1 external, 1 skipped links.",
          ]);
          expect(readFileSync(githubOutput, "utf8")).toBe("local-links=2\nexternal-links=1\n");
        }),
      );
    });

    it.effect("--dry-run --json prints the collected links as JSON", () =>
      run(["files", "a.md", "--dry-run", "--json"], {
        cwd: project({ "a.md": "[B](b.md)\n" }),
      }).pipe(
        Effect.tap(({ code, stdout }) => {
          expect(code).toBe(0);
          expect(stdout).toHaveLength(1);
          expect(JSON.parse(stdout[0] ?? "")).toEqual({
            files: ["a.md"],
            local: [{ href: "b.md", page: "a.md", text: "B", line: 1 }],
            external: [],
            skipped: [],
          });
        }),
      ),
    );

    it.effect("returns 1 when no file matches", () =>
      run(["files", "nope/*.md"]).pipe(
        Effect.tap(({ code, stderr }) => {
          expect(code).toBe(1);
          expect(stderr.join("\n")).toContain('No markdown files match "nope/*.md"');
        }),
      ),
    );
  });

  describe("baseline", () => {
    it.effect("ignores matching links, --update-baseline writes failures and passes", () =>
      Effect.gen(function* () {
        const dir = tempDir();
        const cwd = project();
        const baselinePath = join(dir, "baseline.json");
        const args = ["files", "docs/*.md", "--baseline", baselinePath, "--output-dir", dir];

        // Missing baseline file without --update-baseline
        const missing = yield* run(args, { cwd });
        expect(missing.code).toBe(2);
        expect(missing.stderr).toEqual([`Error: Baseline file not found: ${baselinePath}`]);

        // Update creates it
        const updated = yield* run([...args, "--update-baseline"], { cwd });
        expect(updated.code).toBe(0);
        expect(updated.stderr).toEqual(["Found 1 links to fix, added to the baseline."]);
        expect(updated.stdout).toContain(`Updated baseline ${baselinePath}: 1 entries (was 0).`);
        expect(readJson(baselinePath)).toEqual({
          ignore: [{ href: "../nope.md", page: "docs/guide.md" }],
        });

        // Next run passes, the link is ignored
        const next = yield* run(args, { cwd });
        expect(next.code).toBe(0);
        expect(next.stdout).toContain(`Using baseline ${baselinePath} (1 entries).`);
        expect(next.stdout.filter((line) => line.includes("nope.md"))).toEqual([]);
        expect(readJson(join(dir, "local-files.json"))).toMatchObject({
          summary: { totalLinksToFix: 0, ignored: 1 },
        });
      }),
    );

    it.effect(
      "--update-baseline on a partial scope keeps entries of other files, --prune-baseline drops them",
      () =>
        Effect.gen(function* () {
          const dir = project();
          const baselinePath = join(dir, "baseline.json");
          const otherEntry = {
            href: "missing.md",
            page: "other/README.md",
            reason: "shared baseline",
          };
          writeFileSync(baselinePath, JSON.stringify({ ignore: [otherEntry] }));
          const update = (...extra: string[]) =>
            run(
              [
                "files",
                "docs/*.md",
                "--baseline",
                baselinePath,
                "--update-baseline",
                "--output-dir",
                dir,
                ...extra,
              ],
              { cwd: dir },
            ).pipe(Effect.map(({ code }) => code));

          expect(yield* update()).toBe(0);
          expect(readJson(baselinePath)).toEqual({
            ignore: [otherEntry, { href: "../nope.md", page: "docs/guide.md" }],
          });

          expect(yield* update("--prune-baseline")).toBe(0);
          expect(readJson(baselinePath)).toEqual({
            ignore: [{ href: "../nope.md", page: "docs/guide.md" }],
          });
        }),
    );

    it.effect("returns 2 with a clear message for an invalid file", () => {
      const baselinePath = join(tempDir(), "baseline.json");
      const outputDir = tempDir();
      writeFileSync(baselinePath, JSON.stringify({ ignore: [{ url: "x" }] }));
      return run([
        "files",
        "docs/*.md",
        "--baseline",
        baselinePath,
        "--output-dir",
        outputDir,
      ]).pipe(
        Effect.tap(({ code, stderr }) => {
          expect(code).toBe(2);
          expect(stderr.join("\n")).toContain(
            `Invalid baseline file ${baselinePath}: ignore[0].url: is unexpected`,
          );
          // Nothing was checked
          expect(existsSync(join(outputDir, "local-files.json"))).toBe(false);
        }),
      );
    });
  });

  describe("site", () => {
    const site = "https://site.example";
    // One page that links to a working and a missing URL below `/keep`, to a missing URL elsewhere and to another site
    const handler: FetchHandler = (url) => {
      const { pathname } = new URL(url);
      if (pathname === "/sitemap.xml") {
        return new Response(`<urlset><url><loc>${site}/page</loc></url></urlset>`);
      }
      if (pathname === "/page") {
        const hrefs = [`${site}/keep/ok`, `${site}/keep/missing`, `${site}/other/missing`];
        return new Response(
          [...hrefs, "https://other.example/x"].map((href) => `<a href="${href}">x</a>`).join(""),
        );
      }
      return new Response("", { status: pathname.endsWith("missing") ? 404 : 200 });
    };

    it.effect(
      "checks the sitemap pages, --include (repeatable) filters links, reports links to fix, applies the baseline",
      () => {
        const outputDir = tempDir();
        const args = [
          "site",
          site,
          "--include",
          `${site}/keep`,
          "--include=https://other.example",
          "--output-dir",
          outputDir,
        ];
        const reportPath = join(outputDir, "site-example.json");
        return Effect.gen(function* () {
          expect((yield* run(args, { fetch: handler })).code).toBe(1);
          // /keep/ok, /keep/missing and other.example, not /other/missing
          expect(readJson(reportPath)).toMatchObject({
            summary: { linksChecked: 3, totalLinksToFix: 1 },
          });

          const baselinePath = join(tempDir(), "baseline.json");
          writeFileSync(baselinePath, JSON.stringify({ ignore: [{ pattern: `${site}/**` }] }));
          expect((yield* run([...args, "--baseline", baselinePath], { fetch: handler })).code).toBe(
            0,
          );
          expect(readJson(reportPath)).toMatchObject({
            summary: { totalLinksToFix: 0, ignored: 1 },
          });
        });
      },
    );

    it.effect("warns and passes when the site has no sitemap", () =>
      run(["site", site, "--output-dir", tempDir()], {
        fetch: () => new Response("", { status: 404 }),
      }).pipe(
        Effect.tap(({ code, stderr }) => {
          expect(code).toBe(0);
          expect(stderr).toEqual(["No sitemap.xml or sitemap-index.xml found"]);
        }),
      ),
    );
  });

  describe("github-org", () => {
    const repo = (name: string) => ({
      full_name: `org/${name}`,
      name,
      archived: false,
      owner: { login: "org" },
    });
    const orgApi: Partial<GitHubApi> = {
      listOrgRepos: () => Effect.succeed([repo("a"), repo("b")]),
      getRepo: () => Effect.succeed({ default_branch: "main" }),
      getTreeEntries: () => Effect.succeed([{ type: "blob", path: "README.md" }]),
    };

    it.effect(
      "checks the READMEs of the repositories, applies the sample rate, names the report",
      () => {
        const outputDir = tempDir();
        return run(["github-org", "org", "--sample-rate", "0.5", "--output-dir", outputDir], {
          github: orgApi,
          fetch: (url) =>
            new Response(
              url.startsWith("https://raw.githubusercontent.com/") ? "[X](https://x.example/)" : "",
            ),
        }).pipe(
          Effect.tap(({ code, stdout }) => {
            expect(code).toBe(0);
            expect(stdout).toContain("Sampling 1 of 2 README files (sample rate 0.5).");
            expect(readJson(join(outputDir, "org-github-readmes.json"))).toMatchObject({
              summary: { linksChecked: 1, totalLinksToFix: 0 },
            });
          }),
        );
      },
    );

    it.effect("returns 1 when the repositories cannot be listed", () =>
      run(["github-org", "org"], {
        github: {
          listOrgRepos: () =>
            Effect.fail(new GitHubApiError({ status: 500, cause: new Error("GitHub is down") })),
        },
      }).pipe(
        Effect.tap(({ code, stderr }) => {
          expect(code).toBe(1);
          expect(stderr.join("\n")).toContain(
            "Failed to list repositories of GitHub organization org: GitHub is down",
          );
        }),
      ),
    );

    it.effect("returns 1 when the check crashes", () =>
      // The fake GitHub dies for a method nobody gave it
      run(["github-org", "org"], { github: {} }).pipe(
        Effect.tap(({ code, stderr }) => {
          expect(code).toBe(1);
          expect(stderr.join("\n")).toContain("unexpected GitHub call: listOrgRepos");
        }),
      ),
    );
  });
});

describe("runCli()", () => {
  it("returns the exit code of the command, with the environment of the process", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runCli(["--help"])).toBe(0);
      expect(await runCli(["nope"])).toBe(2);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});
