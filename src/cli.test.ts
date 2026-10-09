import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { formatFileProblems, runCli } from "./cli";
import { getJSONReport } from "./report/report";

// GitHub organizations need GH_TOKEN and the network: fake client and README downloads
const repo = (name: string) => ({
  full_name: `org/${name}`,
  owner: { login: "org" },
  name,
  archived: false,
});
const octokit = {
  paginate: vi.fn(),
  repos: { listForOrg: {}, get: vi.fn() },
  git: { getTree: vi.fn() },
};
const readmeFetch = vi.fn(
  async (_url: string | URL | Request) => new Response("[x](https://example.com/)"),
);
const githubDeps = { octokit: () => octokit as never, fetch: readmeFetch };

// Local site for the `site` command: a sitemap with one page linking to a working and two missing URLs
let server: Server;
let siteUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const send = (status: number, body = "") => {
      res.writeHead(status, { "content-type": "text/html" });
      res.end(body);
    };
    if (req.url === "/sitemap.xml") {
      send(200, `<urlset><url><loc>${siteUrl}/page</loc></url></urlset>`);
    } else if (req.url === "/page") {
      send(
        200,
        `<a href="/keep/ok">ok</a><a href="/keep/missing">a</a><a href="/other/missing">b</a>`,
      );
    } else {
      send(req.url === "/keep/ok" ? 200 : 404);
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server has no port");
  }
  siteUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

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
    octokit.paginate.mockReset().mockResolvedValue([]);
    octokit.repos.get.mockReset().mockResolvedValue({ data: { default_branch: "main" } });
    octokit.git.getTree.mockReset().mockResolvedValue({
      data: {
        tree: [
          { type: "blob", path: "README.md" },
          { type: "blob", path: "docs/README.md" },
        ],
      },
    });
    readmeFetch.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("arguments and options", () => {
    // Number of files checked by `files --dry-run`, 3 files match without sampling
    const filesChecked = async (args: string[], env: Record<string, string> = {}) => {
      stdout = "";
      const code = await runCli(["files", "docs/*.md", "--dry-run", ...args], io(env));
      expect(stderr).toBe("");
      expect(code).toBe(0);
      return Number(/^(\d+) files,/m.exec(stdout)?.[1]);
    };

    it("--sample-rate limits the checked files, LINK_CHECK_SAMPLE_RATE is the default and flags win", async () => {
      const env = { LINK_CHECK_SAMPLE_RATE: "0.1" };
      expect(await filesChecked([])).toBe(3);
      expect(await filesChecked(["--sample-rate", "0.5"])).toBe(2);
      expect(await filesChecked([], env)).toBe(1);
      expect(await filesChecked(["--sample-rate=1"], env)).toBe(3);
    });

    it("FAIL_ON_BROKEN_LINKS=false and --no-fail-on-broken only report links to fix", async () => {
      const outputDir = tempDir();
      const exitCode = (args: string[], env: Record<string, string> = {}) =>
        runCli(["files", "docs/*.md", "--output-dir", outputDir, ...args], io(env));
      expect(await exitCode([])).toBe(1);
      expect(await exitCode([], { FAIL_ON_BROKEN_LINKS: "true" })).toBe(1);
      expect(await exitCode([], { FAIL_ON_BROKEN_LINKS: "false" })).toBe(0);
      expect(await exitCode(["--no-fail-on-broken"])).toBe(0);
      expect(await exitCode(["--fail-on-broken"], { FAIL_ON_BROKEN_LINKS: "false" })).toBe(1);
    });

    it("LINK_CHECK_BASELINE is the default baseline file", async () => {
      const baselinePath = join(tempDir(), "env.json");
      writeFileSync(baselinePath, JSON.stringify({ ignore: [{ href: "../nope.md" }] }));
      const outputDir = tempDir();
      expect(
        await runCli(
          ["files", "docs/*.md", "--output-dir", outputDir],
          io({ LINK_CHECK_BASELINE: baselinePath }),
        ),
      ).toBe(0);
      const report = JSON.parse(readFileSync(join(outputDir, "local-files.json"), "utf8"));
      expect(report.summary).toMatchObject({ totalLinksToFix: 0, ignored: 1 });
    });

    it("--update-baseline writes the default baseline file and reads a relative --baseline in io.cwd, not process.cwd()", async () => {
      const cwd = tempDir();
      mkdirSync(join(cwd, "docs"));
      writeFileSync(join(cwd, "docs/guide.md"), "[broken](../nope.md)\n");
      const run = (args: string[]) =>
        runCli(["files", "docs/*.md", "--output-dir", tempDir(), ...args], { ...io(), cwd });

      expect(await run(["--update-baseline"])).toBe(0);
      expect(JSON.parse(readFileSync(join(cwd, "linkcheck.baseline.json"), "utf8"))).toEqual({
        ignore: [{ href: "../nope.md", page: "docs/guide.md" }],
      });
      // The baseline is found again by its relative path and covers the broken link
      expect(await run(["--baseline", "linkcheck.baseline.json"])).toBe(0);
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

    const badEnv = [
      ["LINK_CHECK_SAMPLE_RATE", "abc"],
      ["LINK_CHECK_HOST_CONCURRENCY", "-1"],
    ] as const;

    it("rejects invalid environment variables when they are used (exit code 2)", async () => {
      for (const [name, value] of badEnv) {
        stderr = "";
        expect(await runCli(["files", "a.md"], io({ [name]: value }))).toBe(2);
        expect(stderr).toContain(`Invalid ${name} "${value}"`);
      }
    });

    it("ignores invalid environment variables for --help and for flags that override them", async () => {
      const env = Object.fromEntries(badEnv);
      expect(await runCli(["--help"], io(env))).toBe(0);
      expect(await runCli(["site", "--help"], io(env))).toBe(0);
      expect(await filesChecked(["--sample-rate", "0.5", "--host-concurrency", "3"], env)).toBe(2);
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
    // Only the message, no stack trace
    expect(stderr).toBe('Error: No markdown files match "nope/*.md".\n');
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

  it("baseline: returns 2 with a clear message for an invalid file", async () => {
    const baselinePath = join(tempDir(), "baseline.json");
    writeFileSync(baselinePath, JSON.stringify({ ignore: [{ url: "x" }] }));
    expect(await runCli(["files", "docs/*.md", "--baseline", baselinePath], io())).toBe(2);
    expect(stderr).toContain(
      `Invalid baseline file ${baselinePath}: ignore[0]: Unrecognized key: "url"`,
    );
  });

  it("site: checks the sitemap pages, --include (repeatable) filters links, reports links to fix, applies the baseline", async () => {
    const outputDir = tempDir();
    const args = [
      "site",
      siteUrl,
      "--include",
      `${siteUrl}/keep`,
      "--include=https://other.example",
      "--output-dir",
      outputDir,
    ];
    expect(await runCli(args, io())).toBe(1);
    const reportPath = join(outputDir, "127-0-0-1.json");
    expect(JSON.parse(readFileSync(reportPath, "utf8")).summary).toMatchObject({
      linksChecked: 2,
      totalLinksToFix: 1,
    });

    const baselinePath = join(tempDir(), "baseline.json");
    writeFileSync(baselinePath, JSON.stringify({ ignore: [{ pattern: `${siteUrl}/**` }] }));
    expect(await runCli([...args, "--baseline", baselinePath], io())).toBe(0);
    expect(JSON.parse(readFileSync(reportPath, "utf8")).summary).toMatchObject({
      totalLinksToFix: 0,
      ignored: 1,
    });
  });

  it("github-org: passes the organization and sample rate, names the report", async () => {
    octokit.paginate.mockResolvedValue(["a", "b"].map(repo));
    const outputDir = tempDir();
    expect(
      await runCli(["github-org", "org", "--sample-rate", "0.5", "--output-dir", outputDir], {
        ...io(),
        deps: githubDeps,
      }),
    ).toBe(0);
    expect(octokit.paginate).toHaveBeenCalledWith(
      octokit.repos.listForOrg,
      expect.objectContaining({ org: "org" }),
    );
    // 4 README files, half of them are checked
    expect(readmeFetch.mock.calls.filter(([url]) => String(url).includes("raw."))).toHaveLength(2);
    expect(existsSync(join(outputDir, "org-github-readmes.json"))).toBe(true);
  });

  it("returns 1 when the check crashes", async () => {
    octokit.paginate.mockRejectedValue(new Error("GitHub exploded"));
    expect(await runCli(["github-org", "org"], { ...io(), deps: githubDeps })).toBe(1);
    expect(stderr).toContain("GitHub exploded");
  });

  it("prints only the message when the organization can't be listed", async () => {
    octokit.paginate.mockRejectedValue(new Error("GitHub exploded"));
    expect(await runCli(["github-org", "org"], { ...io(), deps: githubDeps })).toBe(1);
    expect(stderr).toBe(
      "Error: Failed to list repositories of GitHub organization org: GitHub exploded\n",
    );
  });
});
