import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import { it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import { beforeEach, describe, expect, vi } from "vitest";
import { formatFileProblems, runCli, runCliEffect } from "./cli";
import { NoMarkdownFiles } from "./errors";
import { getJSONReport } from "./report/report";
import { testRunLayer } from "./test/layers";
import { makeTestConsole } from "./test/test_console";
import type { Link, LinkWithResult } from "./types";

// The check functions belong to other modules and are tested there: here they are faked, the tests are about
// what the CLI passes to them and what it does with their results
const checks = vi.hoisted(() => ({
  checkLocalFiles: vi.fn(),
  collectLinksFromFiles: vi.fn(),
  checkWebsite: vi.fn(),
  checkReadmesInGithubOrg: vi.fn(),
}));
vi.mock("./local_files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./local_files")>()),
  checkLocalFiles: checks.checkLocalFiles,
  collectLinksFromFiles: checks.collectLinksFromFiles,
}));
vi.mock("./website", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./website")>()),
  checkWebsite: checks.checkWebsite,
}));
vi.mock("./github/gh_get_links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./github/gh_get_links")>()),
  checkReadmesInGithubOrg: checks.checkReadmesInGithubOrg,
}));

const tempDir = () => mkdtempSync(join(tmpdir(), "cli-test-"));

const link = (href: string, extra: Partial<Link> = {}): Link => ({
  href,
  page: "docs/guide.md",
  text: "",
  ...extra,
});
const brokenLocal: LinkWithResult = {
  ...link("../nope.md", { line: 8 }),
  result: { ok: false, error: "broken link", errorDetail: "File not found: nope.md" },
};
const okLocal: LinkWithResult = {
  ...link("../README.md#getting-started", { line: 7 }),
  result: { ok: true, status: 200 },
};

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

type RunOptions = { readonly env?: Record<string, string>; readonly cwd?: string };

/** Runs the CLI with a fake environment and captured output */
const run = (args: string[], { env = {}, cwd = tempDir() }: RunOptions = {}) => {
  const testConsole = makeTestConsole();
  return runCliEffect(args, { cwd, runLayer: () => testRunLayer() }).pipe(
    Effect.withConfigProvider(ConfigProvider.fromMap(new Map(Object.entries(env)))),
    Effect.withConsole(testConsole.console),
    Effect.provide(NodeFileSystem.layer),
    Effect.map((code) => ({ code, stdout: testConsole.stdout, stderr: testConsole.stderr })),
  );
};

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

describe("runCliEffect()", () => {
  beforeEach(() => {
    checks.checkLocalFiles.mockReset().mockReturnValue(Effect.succeed([okLocal, brokenLocal]));
    checks.collectLinksFromFiles.mockReset();
    checks.checkWebsite.mockReset();
    checks.checkReadmesInGithubOrg.mockReset().mockReturnValue(Effect.succeed([]));
  });

  describe("arguments and options", () => {
    const dryRun = (args: string[], env: Record<string, string> = {}) => {
      checks.collectLinksFromFiles.mockReturnValue(
        Effect.succeed({ files: [], local: [], external: [], skipped: [] }),
      );
      return run(["files", "docs/*.md", "--dry-run", ...args], { env }).pipe(
        Effect.map(({ code, stderr }) => {
          expect(stderr).toEqual([]);
          expect(code).toBe(0);
          return checks.collectLinksFromFiles.mock.lastCall?.[0].sampleRate;
        }),
      );
    };

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
        const runWith = (args: string[], env: Record<string, string> = {}) => {
          const testConsole = makeTestConsole();
          return runCliEffect(["files", "a.md", "--output-dir", tempDir(), ...args], {
            cwd: tempDir(),
            runLayer: ({ hostConcurrency }) => {
              concurrencies.push(hostConcurrency);
              return testRunLayer();
            },
          }).pipe(
            Effect.withConfigProvider(ConfigProvider.fromMap(new Map(Object.entries(env)))),
            Effect.withConsole(testConsole.console),
            Effect.provide(NodeFileSystem.layer),
          );
        };
        yield* runWith(["--no-fail-on-broken"]);
        yield* runWith(["--host-concurrency", "3", "--no-fail-on-broken"]);
        yield* runWith(["--no-fail-on-broken"], { LINK_CHECK_HOST_CONCURRENCY: "5" });
        expect(concurrencies).toEqual([8, 3, 5]);
      }),
    );

    it.effect("FAIL_ON_BROKEN_LINKS=false and --no-fail-on-broken only report links to fix", () =>
      Effect.gen(function* () {
        const outputDir = tempDir();
        const exitCode = (args: string[], env: Record<string, string> = {}) =>
          run(["files", "docs/*.md", "--output-dir", outputDir, ...args], { env }).pipe(
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
          const cwd = tempDir();
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
    it.each(usageErrors)("rejects %j with exit code 2", async (args, message) => {
      const { code, stderr } = await Effect.runPromise(run(args));
      expect(code).toBe(2);
      expect(stderr.join("\n")).toContain(message);
      expect(checks.checkLocalFiles).not.toHaveBeenCalled();
    });

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
        const { stdout } = yield* run(["site", "--help"]);
        expect(stdout.join("\n")).toContain("--include <prefix>");
        expect(stdout.join("\n")).toContain("LINK_CHECK_SAMPLE_RATE");
      }),
    );
  });

  it.effect(
    "files: passes patterns and cwd, prints problems, writes reports and outputs, fails on links to fix",
    () => {
      const out = tempDir();
      const cwd = tempDir();
      const githubOutput = join(out, "github-output");
      const summary = join(out, "summary.md");
      writeFileSync(githubOutput, "");
      return run(["files", "docs/*.md", "README.md", "--output-dir", out], {
        cwd,
        env: { GITHUB_OUTPUT: githubOutput, GITHUB_STEP_SUMMARY: summary },
      }).pipe(
        Effect.tap(({ code, stdout }) => {
          expect(code).toBe(1);
          expect(checks.checkLocalFiles).toHaveBeenCalledWith({
            patterns: ["docs/*.md", "README.md"],
            cwd,
            sampleRate: 1,
          });
          expect(stdout).toContain(
            "docs/guide.md:8: ../nope.md: broken link: File not found: nope.md",
          );
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
    },
  );

  it.effect("files: logs the summary, the duration and, last, the run metrics", () =>
    run(["files", "docs/*.md", "--output-dir", tempDir(), "--no-fail-on-broken"]).pipe(
      Effect.tap(({ stdout }) => {
        const text = stdout.join("\n");
        expect(text).toContain("linksChecked: 2");
        expect(text).toMatch(/Finished in [\d.]+ seconds\./);
        expect(text.indexOf("Finished in")).toBeLessThan(text.indexOf("Run metrics:"));
      }),
    ),
  );

  it.effect("files: emits annotations in GitHub Actions, and passes with --no-fail-on-broken", () =>
    Effect.gen(function* () {
      const env = { GITHUB_ACTIONS: "true" };
      const args = ["files", "docs/*.md", "--output-dir", tempDir(), "--no-fail-on-broken"];
      const annotated = yield* run(args, { env });
      expect(annotated.code).toBe(0);
      expect(annotated.stdout).toContain(
        "::error file=docs/guide.md,line=8,title=Broken link::../nope.md: broken link: File not found: nope.md",
      );

      const quiet = yield* run([...args, "--no-annotations"], { env });
      expect(quiet.stdout.filter((line) => line.startsWith("::"))).toEqual([]);
      expect(quiet.stdout.filter((line) => line.includes("nope.md"))).toEqual([]);
    }),
  );

  it.effect(
    "files: links local files to the checked commit in the HTML report in GitHub Actions",
    () => {
      const out = tempDir();
      const cwd = tempDir();
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

  it.effect(
    "files --json: prints only the JSON report to stdout, logs and annotations to stderr",
    () =>
      run(["files", "docs/*.md", "--output-dir", tempDir(), "--json", "--no-fail-on-broken"], {
        env: { GITHUB_ACTIONS: "true" },
      }).pipe(
        Effect.tap(({ code, stdout, stderr }) => {
          expect(code).toBe(0);
          expect(stdout).toHaveLength(1);
          expect(JSON.parse(stdout[0] ?? "")).toMatchObject({
            summary: { linksChecked: 2, totalLinksToFix: 1 },
          });
          expect(stderr).toContain(
            "::error file=docs/guide.md,line=8,title=Broken link::../nope.md: broken link: File not found: nope.md",
          );
          expect(stderr.some((line) => line.startsWith("Saved JSON report to"))).toBe(true);
          expect(stderr.some((line) => line.startsWith("Run metrics:"))).toBe(true);
        }),
      ),
  );

  it.effect("files --dry-run: lists links without checking them", () => {
    const githubOutput = join(tempDir(), "github-output");
    writeFileSync(githubOutput, "");
    checks.collectLinksFromFiles.mockReturnValue(
      Effect.succeed({
        files: ["README.md"],
        local: [link("docs/missing.md", { page: "README.md", line: 7 }), link("#top")],
        external: [link("https://example.com/page", { page: "README.md", line: 19 })],
        skipped: [link("mailto:hello@example.com", { page: "README.md", line: 18 })],
      }),
    );
    return run(["files", "README.md", "--dry-run"], { env: { GITHUB_OUTPUT: githubOutput } }).pipe(
      Effect.tap(({ code, stdout }) => {
        expect(code).toBe(0);
        expect(stdout).toEqual([
          "local\tREADME.md:7\tdocs/missing.md",
          "local\tdocs/guide.md\t#top",
          "external\tREADME.md:19\thttps://example.com/page",
          "skipped\tREADME.md:18\tmailto:hello@example.com",
          "1 files, 2 local, 1 external, 1 skipped links.",
        ]);
        expect(readFileSync(githubOutput, "utf8")).toBe("local-links=2\nexternal-links=1\n");
        expect(checks.checkLocalFiles).not.toHaveBeenCalled();
      }),
    );
  });

  it.effect("files --dry-run --json: prints the collected links as JSON", () => {
    const collected = { files: ["a.md"], local: [link("b.md")], external: [], skipped: [] };
    checks.collectLinksFromFiles.mockReturnValue(Effect.succeed(collected));
    return run(["files", "a.md", "--dry-run", "--json"]).pipe(
      Effect.tap(({ code, stdout }) => {
        expect(code).toBe(0);
        expect(stdout).toHaveLength(1);
        expect(JSON.parse(stdout[0] ?? "")).toEqual(collected);
      }),
    );
  });

  it.effect("files: returns 1 when no file matches", () => {
    checks.checkLocalFiles.mockReturnValue(
      Effect.fail(new NoMarkdownFiles({ patterns: ["nope/*.md"] })),
    );
    return run(["files", "nope/*.md"]).pipe(
      Effect.tap(({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr.join("\n")).toContain('No markdown files match "nope/*.md"');
      }),
    );
  });

  it.effect("baseline: ignores matching links, --update-baseline writes failures and passes", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      const baselinePath = join(dir, "baseline.json");
      const args = ["files", "docs/*.md", "--baseline", baselinePath, "--output-dir", dir];

      // Missing baseline file without --update-baseline
      const missing = yield* run(args);
      expect(missing.code).toBe(2);
      expect(missing.stderr).toEqual([`Error: Baseline file not found: ${baselinePath}`]);

      // Update creates it
      const updated = yield* run([...args, "--update-baseline"]);
      expect(updated.code).toBe(0);
      expect(updated.stderr).toEqual(["Found 1 links to fix, added to the baseline."]);
      expect(updated.stdout).toContain(`Updated baseline ${baselinePath}: 1 entries (was 0).`);
      expect(readJson(baselinePath)).toEqual({
        ignore: [{ href: "../nope.md", page: "docs/guide.md" }],
      });

      // Next run passes, the link is ignored
      const next = yield* run(args);
      expect(next.code).toBe(0);
      expect(next.stdout).toContain(`Using baseline ${baselinePath} (1 entries).`);
      expect(next.stdout.filter((line) => line.includes("nope.md"))).toEqual([]);
      expect(readJson(join(dir, "local-files.json"))).toMatchObject({
        summary: { totalLinksToFix: 0, ignored: 1 },
      });
    }),
  );

  it.effect(
    "baseline: --update-baseline on a partial scope keeps entries of other files, --prune-baseline drops them",
    () =>
      Effect.gen(function* () {
        const dir = tempDir();
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

  it.effect("baseline: returns 2 with a clear message for an invalid file", () => {
    const baselinePath = join(tempDir(), "baseline.json");
    writeFileSync(baselinePath, JSON.stringify({ ignore: [{ url: "x" }] }));
    return run(["files", "docs/*.md", "--baseline", baselinePath]).pipe(
      Effect.tap(({ code, stderr }) => {
        expect(code).toBe(2);
        expect(stderr.join("\n")).toContain(
          `Invalid baseline file ${baselinePath}: ignore[0].url: is unexpected`,
        );
        expect(checks.checkLocalFiles).not.toHaveBeenCalled();
      }),
    );
  });

  it.effect(
    "site: checks the sitemap pages, --include (repeatable) filters links, reports links to fix, applies the baseline",
    () => {
      // Fake of the site check: the page links to a working and two missing URLs, only the filtered ones are checked
      const site = "https://site.example";
      const page = `${site}/page`;
      const found = [
        { ...link(`${site}/keep/ok`, { page }), result: { ok: true as const, status: 200 } },
        {
          ...link(`${site}/keep/missing`, { page }),
          result: { ok: false as const, error: "broken link" as const, status: 404 },
        },
        {
          ...link(`${site}/other/missing`, { page }),
          result: { ok: false as const, error: "broken link" as const, status: 404 },
        },
      ];
      checks.checkWebsite.mockImplementation(
        ({ linkFilter }: { linkFilter?: (link: Link) => boolean }) =>
          Effect.succeed(found.filter((item) => linkFilter?.(item) ?? true)),
      );
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
        expect((yield* run(args)).code).toBe(1);
        expect(checks.checkWebsite).toHaveBeenCalledWith(
          expect.objectContaining({ websiteUrl: site, sampleRate: 1 }),
        );
        expect(readJson(reportPath)).toMatchObject({
          summary: { linksChecked: 2, totalLinksToFix: 1 },
        });

        const baselinePath = join(tempDir(), "baseline.json");
        writeFileSync(baselinePath, JSON.stringify({ ignore: [{ pattern: `${site}/**` }] }));
        expect((yield* run([...args, "--baseline", baselinePath])).code).toBe(0);
        expect(readJson(reportPath)).toMatchObject({ summary: { totalLinksToFix: 0, ignored: 1 } });
      });
    },
  );

  it.effect("github-org: passes the organization and sample rate, names the report", () => {
    const outputDir = tempDir();
    return run(["github-org", "org", "--sample-rate", "0.5", "--output-dir", outputDir]).pipe(
      Effect.tap(({ code }) => {
        expect(code).toBe(0);
        expect(checks.checkReadmesInGithubOrg).toHaveBeenCalledWith("org", { sampleRate: 0.5 });
        expect(existsSync(join(outputDir, "org-github-readmes.json"))).toBe(true);
      }),
    );
  });

  it.effect("returns 1 when the check crashes", () => {
    checks.checkReadmesInGithubOrg.mockReturnValue(Effect.die(new Error("GitHub exploded")));
    return run(["github-org", "org"]).pipe(
      Effect.tap(({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr.join("\n")).toContain("GitHub exploded");
      }),
    );
  });

  it.effect("returns 1 when the check fails with an error", () => {
    checks.checkReadmesInGithubOrg.mockReturnValue(
      Effect.fail(new Error("Failed to list repositories")),
    );
    return run(["github-org", "org"]).pipe(
      Effect.tap(({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr.join("\n")).toContain("Failed to list repositories");
      }),
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
