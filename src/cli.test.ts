import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getHelp, parseCliArgs, runCli, UsageError } from "./cli";

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

describe("parseCliArgs()", () => {
  const parse = (args: string[], env: Record<string, string> = {}) => parseCliArgs(args, env);
  const optionsOf = (args: string[], env: Record<string, string> = {}) => {
    const command = parse(args, env);
    if (command.command === "help") {
      throw new Error("Expected a command, got help");
    }
    return command.options;
  };
  const defaults = {
    sampleRate: 1,
    failOnBroken: true,
    baseline: undefined,
    updateBaseline: false,
    outputDir: "results",
    json: false,
  };

  it("parses site with --include prefixes", () => {
    expect(
      parse(["site", "https://example.com", "--include", "https://a.com", "--include=https://b"]),
    ).toEqual({
      command: "site",
      url: "https://example.com",
      include: ["https://a.com", "https://b"],
      usePlaywright: false,
      options: defaults,
    });
  });

  it("parses github-org and files", () => {
    expect(parse(["github-org", "fingerprintjs"])).toEqual({
      command: "github-org",
      org: "fingerprintjs",
      options: defaults,
    });
    expect(parse(["files", "docs/**/*.md", "README.md", "--dry-run"])).toEqual({
      command: "files",
      patterns: ["docs/**/*.md", "README.md"],
      dryRun: true,
      annotations: true,
      options: defaults,
    });
    expect(parse(["files", "a.md", "--no-annotations"])).toMatchObject({ annotations: false });
  });

  it("parses common options", () => {
    expect(
      parse([
        "files",
        "a.md",
        "--sample-rate",
        "0.5",
        "--no-fail-on-broken",
        "--baseline",
        "b.json",
        "--output-dir",
        "out",
        "--json",
        "--host-concurrency",
        "3",
      ]),
    ).toMatchObject({
      options: {
        sampleRate: 0.5,
        failOnBroken: false,
        baseline: "b.json",
        updateBaseline: false,
        outputDir: "out",
        json: true,
        hostConcurrency: 3,
      },
    });
  });

  it("uses environment variables as defaults, flags win", () => {
    const env = {
      FAIL_ON_BROKEN_LINKS: "false",
      LINK_CHECK_SAMPLE_RATE: "0.1",
      LINK_CHECK_BASELINE: "env.json",
    };
    expect(optionsOf(["files", "a.md"], env)).toMatchObject({
      failOnBroken: false,
      sampleRate: 0.1,
      baseline: "env.json",
    });
    expect(
      optionsOf(["files", "a.md", "--fail-on-broken", "--sample-rate=1", "--baseline=x.json"], env),
    ).toMatchObject({ failOnBroken: true, sampleRate: 1, baseline: "x.json" });
    expect(optionsOf(["files", "a.md"], { FAIL_ON_BROKEN_LINKS: "true" }).failOnBroken).toBe(true);
  });

  it("--update-baseline defaults the baseline file", () => {
    expect(optionsOf(["files", "a.md", "--update-baseline"])).toMatchObject({
      updateBaseline: true,
      baseline: "linkcheck.baseline.json",
    });
  });

  it("returns help for --help, -h and help <command>", () => {
    expect(parse(["--help"])).toEqual({ command: "help", topic: undefined });
    expect(parse(["files", "-h"])).toEqual({ command: "help", topic: "files" });
    expect(parse(["help", "site"])).toEqual({ command: "help", topic: "site" });
    expect(getHelp("files")).toContain("files <glob...>");
    expect(getHelp()).toContain("github-org <org>");
  });

  it.each([
    [[], "Missing command."],
    [["nope"], 'Unknown command "nope"'],
    [["files"], "files expects at least one glob pattern"],
    [["site"], "site expects exactly one URL, got 0."],
    [["site", "a", "b"], "site expects exactly one URL, got 2."],
    [["site", "not a url"], 'Invalid URL "not a url".'],
    [["site", "file:///etc/passwd"], "expected an http(s) URL"],
    [["site", "https://a.com", "--include="], "--include must not be empty."],
    [["github-org"], "github-org expects exactly one organization"],
    [["github-org", "../x"], 'Invalid GitHub organization "../x".'],
    [["files", "a.md", "--include", "x"], "--include can only be used with the site command."],
    [["site", "https://a.com", "--dry-run"], "--dry-run can only be used with the files command."],
    [["github-org", "x", "--no-annotations"], "--annotations can only be used with the files"],
    [["files", "a.md", "--sample-rate", "2"], 'Invalid --sample-rate "2"'],
    [["files", "a.md", "--sample-rate="], "--sample-rate must not be empty."],
    [["files", "a.md", "--host-concurrency", "0"], 'Invalid --host-concurrency "0"'],
    [["files", "a.md", "--unknown"], "Unknown option '--unknown'"],
    [["files", "a.md", "--baseline"], "--baseline"],
  ])("rejects %j", (args, message) => {
    expect(() => parse(args)).toThrow(UsageError);
    expect(() => parse(args)).toThrow(message);
  });

  it("rejects invalid environment variables", () => {
    expect(() => parse(["files", "a.md"], { LINK_CHECK_SAMPLE_RATE: "abc" })).toThrow(
      'Invalid LINK_CHECK_SAMPLE_RATE "abc"',
    );
    expect(() => parse(["files", "a.md"], { LINK_CHECK_HOST_CONCURRENCY: "-1" })).toThrow(
      'Invalid LINK_CHECK_HOST_CONCURRENCY "-1"',
    );
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

  it("prints help and returns 0", async () => {
    expect(await runCli(["--help"], io())).toBe(0);
    expect(stdout).toContain("Usage:");
  });

  it("returns 2 for usage errors", async () => {
    expect(await runCli(["nope"], io())).toBe(2);
    expect(stderr).toContain('Error: Unknown command "nope"');
    expect(stderr).toContain("--help");
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
    const args = mocks.checkWebsite.mock.calls[0][0];
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
    });
  });

  it("returns 1 when the check crashes", async () => {
    mocks.checkWebsite.mockRejectedValue(new Error("sitemap exploded"));
    expect(await runCli(["site", "https://example.com"], io())).toBe(1);
    expect(stderr).toContain("sitemap exploded");
  });
});
