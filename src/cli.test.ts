import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatFileProblems, runCli } from "./cli";
import { getJSONReport } from "./report/report";

const mocks = vi.hoisted(() => ({
  checkWebsite: vi.fn(),
  checkReadmesInGithubOrg: vi.fn(),
}));
vi.mock("./website", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./website")>()),
  checkWebsite: mocks.checkWebsite,
}));
vi.mock("./github/gh_get_links", () => ({
  checkReadmesInGithubOrg: mocks.checkReadmesInGithubOrg,
}));
// Local files mode must never hit the network in these tests
vi.mock("./link", () => ({
  checkLinks: vi.fn(async () => {
    throw new Error("checkLinks must not be called");
  }),
}));

const FIXTURE = resolve(import.meta.dirname, "__fixtures__/local");
const tempDir = () => mkdtempSync(join(tmpdir(), "cli-test-"));

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

describe("runCli()", () => {
  let stdout: string;
  let stderr: string;
  const io = (env: Record<string, string> = {}) => ({
    env,
    cwd: FIXTURE,
    stdout: (text: string) => {
      stdout += text;
    },
    stderr: (text: string) => {
      stderr += text;
    },
  });

  beforeEach(() => {
    stdout = "";
    stderr = "";
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.checkWebsite.mockReset();
    mocks.checkReadmesInGithubOrg.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("arguments and options", () => {
    const emptyReport = {
      siteName: "example.com",
      summary: { totalLinksToFix: 0 },
      brokenLinks: [],
      hashNotFound: [],
      networkErrors: [],
      couldNotCheck: [],
      ignored: [],
    };
    /** Options the check was started with, `site` is the command with the most arguments */
    const checkOptions = async (args: string[], env: Record<string, string> = {}) => {
      mocks.checkWebsite.mockResolvedValue(emptyReport);
      const code = await runCli(["site", "https://example.com", ...args], io(env));
      expect(stderr).toBe("");
      expect(code).toBe(0);
      return mocks.checkWebsite.mock.calls[0]![0];
    };

    it("uses defaults without flags and environment variables", async () => {
      expect(await checkOptions([])).toMatchObject({
        sampleRate: 1,
        baseline: { entries: [] },
        outputDir: "results",
        hostConcurrency: 8,
        allowPrivateHosts: false,
      });
    });

    it("passes common options", async () => {
      expect(
        await checkOptions(["--sample-rate", "0.5", "--output-dir", "out", "--host-concurrency=3"]),
      ).toMatchObject({ sampleRate: 0.5, outputDir: "out", hostConcurrency: 3 });
    });

    it("uses environment variables as defaults, flags win", async () => {
      const env = {
        LINK_CHECK_SAMPLE_RATE: "0.1",
        LINK_CHECK_HOST_CONCURRENCY: "2",
        LINK_CHECK_ALLOW_PRIVATE_HOSTS: "true",
      };
      expect(await checkOptions([], env)).toMatchObject({
        sampleRate: 0.1,
        hostConcurrency: 2,
        allowPrivateHosts: true,
      });
      mocks.checkWebsite.mockClear();
      expect(
        await checkOptions(["--sample-rate=1", "--no-allow-private-hosts"], env),
      ).toMatchObject({ sampleRate: 1, allowPrivateHosts: false });
    });

    it("FAIL_ON_BROKEN_LINKS=false and --no-fail-on-broken only report links to fix", async () => {
      mocks.checkWebsite.mockResolvedValue({
        ...emptyReport,
        summary: { totalLinksToFix: 1 },
      });
      const exitCode = (args: string[], env: Record<string, string> = {}) =>
        runCli(["site", "https://example.com", ...args], io(env));
      expect(await exitCode([])).toBe(1);
      expect(await exitCode([], { FAIL_ON_BROKEN_LINKS: "true" })).toBe(1);
      expect(await exitCode([], { FAIL_ON_BROKEN_LINKS: "false" })).toBe(0);
      expect(await exitCode(["--no-fail-on-broken"])).toBe(0);
      expect(await exitCode(["--fail-on-broken"], { FAIL_ON_BROKEN_LINKS: "false" })).toBe(1);
    });

    it("LINK_CHECK_BASELINE is the default baseline file, --update-baseline defaults to linkcheck.baseline.json", async () => {
      const dir = tempDir();
      writeFileSync(join(dir, "env.json"), JSON.stringify({ ignore: ["https://a.com/**"] }));
      expect(
        (await checkOptions([], { LINK_CHECK_BASELINE: join(dir, "env.json") })).baseline.entries,
      ).toHaveLength(1);

      // The default file is relative to the current directory
      const cwd = tempDir();
      mocks.checkWebsite.mockResolvedValue(emptyReport);
      const previous = process.cwd();
      process.chdir(cwd);
      try {
        expect(await runCli(["site", "https://example.com", "--update-baseline"], io())).toBe(0);
      } finally {
        process.chdir(previous);
      }
      expect(JSON.parse(readFileSync(join(cwd, "linkcheck.baseline.json"), "utf8"))).toEqual({
        ignore: [],
      });
    });

    it("site: --include is repeatable and filters links by prefix", async () => {
      const { linkFilter } = await checkOptions([
        "--include",
        "https://a.com",
        "--include=https://b",
      ]);
      expect(linkFilter({ href: "https://a.com/x" })).toBe(true);
      expect(linkFilter({ href: "https://b/x" })).toBe(true);
      expect(linkFilter({ href: "https://c.com" })).toBe(false);
    });

    it.each([
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
    ])("rejects %j with exit code 2", async (args, message) => {
      expect(await runCli(args, io())).toBe(2);
      expect(stderr).toContain(message);
    });

    it("rejects invalid environment variables with exit code 2", async () => {
      for (const [name, value] of [
        ["LINK_CHECK_SAMPLE_RATE", "abc"],
        ["LINK_CHECK_HOST_CONCURRENCY", "-1"],
        ["LINK_CHECK_ALLOW_PRIVATE_HOSTS", "yes"],
      ] as const) {
        stderr = "";
        expect(await runCli(["files", "a.md"], io({ [name]: value }))).toBe(2);
        expect(stderr).toContain(`Invalid ${name} "${value}"`);
      }
    });

    it("prints help for help, --help and <command> --help to stdout", async () => {
      for (const args of [["--help"], ["help"], ["files", "-h"], ["help", "site"]]) {
        stdout = "";
        expect(await runCli(args, io())).toBe(0);
        expect(stdout).toContain("Usage: docs-link-checker");
      }
      expect(stdout).toContain("--include <prefix>");
      expect(stdout).toContain("LINK_CHECK_SAMPLE_RATE");
      expect(stderr).toBe("");
    });
  });

  it("files: prints problems with lines, writes reports and outputs, fails on links to fix", async () => {
    const out = tempDir();
    const githubOutput = join(out, "github-output");
    const summary = join(out, "summary.md");
    writeFileSync(githubOutput, "");
    const code = await runCli(
      ["files", "docs/*.md", "--output-dir", out],
      io({ GITHUB_OUTPUT: githubOutput, GITHUB_STEP_SUMMARY: summary }),
    );
    expect(code).toBe(1);
    expect(stdout).toBe("docs/guide.md:8: ../nope.md: broken link: File not found: nope.md\n");
    expect(readFileSync(githubOutput, "utf8")).toBe(
      `links-to-fix=1\nreport-path=${join(out, "local-files.json")}\nreport-html-path=${join(out, "local-files.html")}\n`,
    );
    expect(readFileSync(summary, "utf8")).toContain("| docs/guide.md:8 | ../nope.md |");
    const report = JSON.parse(readFileSync(join(out, "local-files.json"), "utf8"));
    expect(report.summary.totalLinksToFix).toBe(1);
  });

  it("files: emits annotations in GitHub Actions, and passes with --no-fail-on-broken", async () => {
    const code = await runCli(
      ["files", "docs/*.md", "--output-dir", tempDir(), "--no-fail-on-broken"],
      io({ GITHUB_ACTIONS: "true" }),
    );
    expect(code).toBe(0);
    expect(stdout).toBe(
      "::error file=docs/guide.md,line=8,title=Broken link::../nope.md: broken link: File not found: nope.md\n",
    );

    stdout = "";
    await runCli(
      ["files", "docs/*.md", "--output-dir", tempDir(), "--no-fail-on-broken", "--no-annotations"],
      io({ GITHUB_ACTIONS: "true" }),
    );
    expect(stdout).toBe("");
  });

  it("files: links local files to the checked commit in the HTML report in GitHub Actions", async () => {
    const out = tempDir();
    const sha = "0123456789abcdef0123456789abcdef01234567";
    await runCli(
      ["files", "docs/*.md", "--output-dir", out, "--no-fail-on-broken"],
      io({
        GITHUB_ACTIONS: "true",
        GITHUB_WORKSPACE: FIXTURE,
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_SHA: sha,
        GITHUB_SERVER_URL: "https://github.com",
      }),
    );
    const html = readFileSync(join(out, "local-files.html"), "utf8");
    expect(html).toContain(`href="https://github.com/owner/repo/blob/${sha}/docs/guide.md#L8"`);
    expect(html).toContain(`href="https://github.com/owner/repo/blob/${sha}/nope.md"`);
  });

  it("files --json: prints only the JSON report to stdout", async () => {
    const code = await runCli(
      ["files", "docs/*.md", "--output-dir", tempDir(), "--json", "--no-fail-on-broken"],
      io({ GITHUB_ACTIONS: "true" }),
    );
    expect(code).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.summary).toMatchObject({ linksChecked: 2, totalLinksToFix: 1 });
    // Annotations go to stderr in JSON mode
    expect(stderr).toContain("::error file=docs/guide.md,line=8");
  });

  it("files --dry-run: lists links without checking them", async () => {
    const githubOutput = join(tempDir(), "github-output");
    writeFileSync(githubOutput, "");
    expect(
      await runCli(["files", "README.md", "--dry-run"], io({ GITHUB_OUTPUT: githubOutput })),
    ).toBe(0);
    expect(stdout).toContain("local\tREADME.md:7\tdocs/missing.md\n");
    expect(stdout).toContain("external\tREADME.md:19\thttps://example.com/page\n");
    expect(stdout).toContain("skipped\tREADME.md:18\tmailto:hello@example.com\n");
    expect(stdout).toContain("1 files, 14 local, 1 external, 1 skipped links.");
    expect(readFileSync(githubOutput, "utf8")).toBe("local-links=14\nexternal-links=1\n");
  });

  it("files: returns 1 when no file matches", async () => {
    expect(await runCli(["files", "nope/*.md"], io())).toBe(1);
    expect(stderr).toContain('No markdown files match "nope/*.md"');
  });

  it("baseline: ignores matching links, --update-baseline writes failures and passes", async () => {
    const dir = tempDir();
    const baselinePath = join(dir, "baseline.json");

    // Missing baseline file without --update-baseline
    expect(await runCli(["files", "docs/*.md", "--baseline", baselinePath], io())).toBe(2);
    expect(stderr).toContain(`Baseline file not found: ${baselinePath}`);

    // Update creates it
    expect(
      await runCli(
        [
          "files",
          "docs/*.md",
          "--baseline",
          baselinePath,
          "--update-baseline",
          "--output-dir",
          dir,
        ],
        io(),
      ),
    ).toBe(0);
    expect(JSON.parse(readFileSync(baselinePath, "utf8"))).toEqual({
      ignore: [{ href: "../nope.md", page: "docs/guide.md" }],
    });

    // Next run passes, the link is ignored
    stdout = "";
    expect(
      await runCli(["files", "docs/*.md", "--baseline", baselinePath, "--output-dir", dir], io()),
    ).toBe(0);
    expect(stdout).toBe("");
    const report = JSON.parse(readFileSync(join(dir, "local-files.json"), "utf8"));
    expect(report.summary).toMatchObject({ totalLinksToFix: 0, ignored: 1 });
  });

  it("baseline: --update-baseline on a partial scope keeps entries of other files, --prune-baseline drops them", async () => {
    const dir = tempDir();
    const baselinePath = join(dir, "baseline.json");
    const otherEntry = { href: "missing.md", page: "other/README.md", reason: "shared baseline" };
    writeFileSync(baselinePath, JSON.stringify({ ignore: [otherEntry] }));
    const update = (...extra: string[]) =>
      runCli(
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
        io(),
      );

    expect(await update()).toBe(0);
    expect(JSON.parse(readFileSync(baselinePath, "utf8"))).toEqual({
      ignore: [otherEntry, { href: "../nope.md", page: "docs/guide.md" }],
    });

    expect(await update("--prune-baseline")).toBe(0);
    expect(JSON.parse(readFileSync(baselinePath, "utf8"))).toEqual({
      ignore: [{ href: "../nope.md", page: "docs/guide.md" }],
    });
  });

  it("--allow-private-hosts is passed to the check as an explicit option", async () => {
    mocks.checkWebsite.mockResolvedValue({
      siteName: "localhost",
      summary: { totalLinksToFix: 0 },
      brokenLinks: [],
      hashNotFound: [],
      networkErrors: [],
      couldNotCheck: [],
      ignored: [],
    });
    expect(await runCli(["site", "http://localhost:3000", "--allow-private-hosts"], io())).toBe(0);
    expect(mocks.checkWebsite).toHaveBeenCalledTimes(1);
    expect(mocks.checkWebsite.mock.calls[0]![0]).toMatchObject({ allowPrivateHosts: true });
  });

  it("baseline: returns 2 with a clear message for an invalid file", async () => {
    const baselinePath = join(tempDir(), "baseline.json");
    writeFileSync(baselinePath, JSON.stringify({ ignore: [{ url: "x" }] }));
    expect(await runCli(["files", "docs/*.md", "--baseline", baselinePath], io())).toBe(2);
    expect(stderr).toContain(`Invalid baseline file ${baselinePath}: ignore[0]: unknown key "url"`);
  });

  it("site and github-org: pass the options to the checks", async () => {
    const report = {
      siteName: "example.com",
      summary: { totalLinksToFix: 0 },
      brokenLinks: [],
      hashNotFound: [],
      networkErrors: [],
      couldNotCheck: [],
      ignored: [],
    };
    mocks.checkWebsite.mockResolvedValue(report);
    mocks.checkReadmesInGithubOrg.mockResolvedValue({ ...report, siteName: "org GitHub readmes" });

    expect(
      await runCli(
        ["site", "https://example.com", "--include", "https://a.com/", "--sample-rate", "0.2"],
        io(),
      ),
    ).toBe(0);
    const args = mocks.checkWebsite.mock.calls[0]![0];
    expect(args).toMatchObject({
      websiteUrl: "https://example.com",
      sampleRate: 0.2,
      outputDir: "results",
    });
    expect(args.linkFilter({ href: "https://a.com/x" })).toBe(true);
    expect(args.linkFilter({ href: "https://b.com/x" })).toBe(false);

    expect(await runCli(["github-org", "org", "--output-dir", "out"], io())).toBe(0);
    expect(mocks.checkReadmesInGithubOrg).toHaveBeenCalledWith("org", {
      sampleRate: 1,
      baseline: expect.anything(),
      outputDir: "out",
      hostConcurrency: 8,
      allowPrivateHosts: false,
    });
  });

  it("returns 1 when the check crashes", async () => {
    mocks.checkWebsite.mockRejectedValue(new Error("sitemap exploded"));
    expect(await runCli(["site", "https://example.com"], io())).toBe(1);
    expect(stderr).toContain("sitemap exploded");
  });
});
