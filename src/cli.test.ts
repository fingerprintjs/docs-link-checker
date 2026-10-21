import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import * as cheerio from "cheerio";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli";

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
      send(
        200,
        `<urlset><url><loc>${siteUrl}/page</loc></url><url><loc>${siteUrl}/page2</loc></url></urlset>`,
      );
    } else if (req.url === "/page") {
      send(
        200,
        `<a href="/keep/ok">ok</a><a href="/keep/missing">a</a><a href="/other/missing">b</a>`,
      );
    } else if (req.url === "/page2") {
      send(200, `<a href="/keep/missing">same target</a>`);
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

describe("runCli()", () => {
  let stdout: string;
  let stderr: string;
  // Colors depend on the environment of the test run
  const plain = (text: string) => stripVTControlCharacters(text);
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

    it("LINK_CHECK_INDEX_URL and --index-url link the HTML report to the index of all reports", async () => {
      const indexLink = async (args: string[], env: Record<string, string> = {}) => {
        const outputDir = tempDir();
        await runCli(["files", "docs/*.md", "--output-dir", outputDir, ...args], io(env));
        const $ = cheerio.load(readFileSync(join(outputDir, "local-files.html"), "utf8"));
        return $('a:contains("All reports")').attr("href");
      };
      expect(await indexLink([])).toBeUndefined();
      expect(await indexLink([], { LINK_CHECK_INDEX_URL: "https://a.example/" })).toBe(
        "https://a.example/",
      );
      expect(
        await indexLink(["--index-url", "https://b.example/"], {
          LINK_CHECK_INDEX_URL: "https://a.example/",
        }),
      ).toBe("https://b.example/");
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
      ["LINK_CHECK_INDEX_URL", "not-a-url"],
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
      const flags = ["--sample-rate", "0.5", "--host-concurrency", "3"];
      expect(await filesChecked([...flags, "--index-url", "https://a.example/"], env)).toBe(2);
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
    expect(plain(stdout)).toContain(
      "docs/guide.md:8  File not found  ../nope.md  no file nope.md\n",
    );
    expect(readFileSync(githubOutput, "utf8")).toBe(
      `links-to-fix=1\nlinks-to-notify=1\nreport-path=${join(out, "local-files.json")}\nreport-html-path=${join(out, "local-files.html")}\n`,
    );
    expect(readFileSync(summary, "utf8")).toContain(
      "| `../nope.md`<br><sub>no file nope.md</sub> | `docs/guide.md:8` |",
    );
    const report = JSON.parse(readFileSync(join(out, "local-files.json"), "utf8"));
    expect(report.summary.totalLinksToFix).toBe(1);
  });

  describe("--compare", () => {
    const link = (page: string, href: string, error = "broken link") => ({
      page,
      href,
      text: "",
      result: { ok: false, error },
    });
    const previousReport = (brokenLinks: unknown[], generatedAt = new Date()) => {
      const file = join(tempDir(), "previous.json");
      writeFileSync(
        file,
        JSON.stringify({
          generatedAt: generatedAt.toISOString(),
          brokenLinks,
          hashNotFound: [],
          networkErrors: [],
        }),
      );
      return file;
    };
    const runFiles = async (extra: string[], env: Record<string, string> = {}) => {
      const out = tempDir();
      await runCli(["files", "docs/*.md", "--output-dir", out, ...extra], io(env));
      return JSON.parse(readFileSync(join(out, "local-files.json"), "utf8"));
    };

    it("adds the new and fixed links to fix since the previous report", async () => {
      // Still broken: ../nope.md. Fixed: gone.md. The problem counts, not the status or message.
      const previous = previousReport([
        {
          ...link("docs/guide.md", "../nope.md"),
          result: { ok: false, error: "broken link", status: 404 },
        },
        link("docs/guide.md", "gone.md"),
      ]);

      expect((await runFiles(["--compare", previous])).diff).toEqual({
        new: 0,
        fixed: 1,
        reminders: 0,
      });
      expect((await runFiles([], { LINK_CHECK_COMPARE: previous })).diff).toEqual({
        new: 0,
        fixed: 1,
        reminders: 0,
      });
    });

    it("notifies only about new links and reminders", async () => {
      const githubOutput = join(tempDir(), "github-output");
      const stillBroken = previousReport([link("docs/guide.md", "../nope.md")]);

      const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const brokenForAWeek = previousReport(
        [{ ...link("docs/guide.md", "../nope.md"), brokenSince: daysAgo(8).toISOString() }],
        daysAgo(2),
      );

      await runFiles(["--compare", stillBroken], { GITHUB_OUTPUT: githubOutput });
      await runFiles(["--compare", brokenForAWeek], { GITHUB_OUTPUT: githubOutput });

      expect(readFileSync(githubOutput, "utf8").match(/links-to-notify=\d+/g)).toEqual([
        "links-to-notify=0",
        "links-to-notify=1",
      ]);
    });

    it("counts a link that fails in a new way as new and fixed", async () => {
      const previous = previousReport([link("docs/guide.md", "../nope.md", "hash not found")]);

      expect((await runFiles(["--compare", previous])).diff).toEqual({
        new: 1,
        fixed: 1,
        reminders: 0,
      });
    });

    it("names the invalid field when the previous report has the wrong shape", async () => {
      const file = join(tempDir(), "bad.json");
      writeFileSync(
        file,
        JSON.stringify({
          generatedAt: new Date().toISOString(),
          brokenLinks: 1,
          hashNotFound: [],
          networkErrors: [],
        }),
      );

      const report = await runFiles(["--compare", file]);

      expect(report).not.toHaveProperty("diff");
      expect(vi.mocked(console.log).mock.calls.join("\n")).toContain("(brokenLinks: ");
    });

    it("skips the comparison, without failing, when the previous report is missing", async () => {
      const report = await runFiles(["--compare", join(tempDir(), "missing.json")]);

      expect(report).not.toHaveProperty("diff");
      expect(report.summary.totalLinksToFix).toBe(1);
    });
  });

  it("files: emits annotations in GitHub Actions, and passes with --no-fail-on-broken", async () => {
    const code = await runCli(
      ["files", "docs/*.md", "--output-dir", tempDir(), "--no-fail-on-broken"],
      io({ GITHUB_ACTIONS: "true" }),
    );
    expect(code).toBe(0);
    expect(stdout).toContain(
      "::error file=docs/guide.md,line=8,title=File not found::../nope.md: no file nope.md\n",
    );
    expect(stdout).not.toContain("File not found  ../nope.md");

    stdout = "";
    await runCli(
      ["files", "docs/*.md", "--output-dir", tempDir(), "--no-fail-on-broken", "--no-annotations"],
      io({ GITHUB_ACTIONS: "true" }),
    );
    expect(stdout).not.toContain("::error");
    expect(stdout).not.toContain("../nope.md");
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
    expect(stderr).toBe('Error: No markdown or source code files match "nope/*.md".\n');
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
    expect(plain(stdout)).toContain("✓ No links to fix");
    expect(plain(stdout)).toContain("1 ignored by baseline");
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
      linksChecked: 3,
      totalLinksToFix: 2,
    });

    const baselinePath = join(tempDir(), "baseline.json");
    writeFileSync(baselinePath, JSON.stringify({ ignore: [{ pattern: `${siteUrl}/**` }] }));
    expect(await runCli([...args, "--baseline", baselinePath], io())).toBe(0);
    expect(JSON.parse(readFileSync(reportPath, "utf8")).summary).toMatchObject({
      totalLinksToFix: 0,
      ignored: 2,
    });
  });

  it("site: groups links to fix by target with the pages below, then the verdict", async () => {
    const outputDir = tempDir();
    const code = await runCli(
      ["site", siteUrl, "--include", `${siteUrl}/keep`, "--output-dir", outputDir],
      io(),
    );
    expect(code).toBe(1);
    const output = plain(stdout);
    // One target on two pages, site origin dropped, pages with their link text
    expect(output).toContain(
      `HTTP 404  /keep/missing  on 2 pages  Not Found\n          ↳ /page  "a"\n          ↳ /page2  "same target"\n`,
    );
    expect(output).toContain("✗ 2 links to fix (2 broken)");
    expect(output).toContain("3 checked · 0 ignored by baseline · 0 could not check");
    expect(output).toMatch(/Report .*127-0-0-1\.html/);
    expect(output).toContain("False positive? --update-baseline");
  });

  it("files: lists one aligned row per link to fix, with the hash and the reason", async () => {
    await runCli(["files", "README.md", "--output-dir", tempDir()], io());
    const output = plain(stdout);
    expect(output).toContain(
      [
        "README.md:7   File not found     docs/missing.md  no file docs/missing.md",
        "README.md:8   Anchor not found   docs/guide.md#nope  no heading #nope in docs/guide.md",
        "README.md:10  Anchor not found   #nowhere  no heading #nowhere in README.md",
        "README.md:16  Line out of range  src/code.ts#L99  src/code.ts has 3 lines",
        "README.md:19  HTTP 404           example.com/page  Not Found",
      ].join("\n"),
    );
  });

  it("shows --verbose details (run metrics) only when asked for", async () => {
    const args = ["site", siteUrl, "--output-dir", tempDir()];
    await runCli(args, io());
    expect(plain(stdout)).not.toContain("Run metrics");
    expect(plain(stdout)).toContain("✓ Found 4 links in 2 pages");

    stdout = "";
    await runCli([...args, "--verbose"], io());
    expect(plain(stdout)).toContain("Run metrics:");
  });

  it("sends the output to stderr with --json", async () => {
    await runCli(["site", siteUrl, "--output-dir", tempDir(), "--json"], io());
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(plain(stderr)).toContain("✗ 3 links to fix");
  });

  it("redraws one progress line on a TTY instead of printing a line per step", async () => {
    await runCli(["site", siteUrl, "--output-dir", tempDir()], { ...io(), tty: true });
    expect(stdout).toContain("\r\u001B[2K");
    expect(plain(stdout)).toMatch(/Checking URLs\s+\d\/3\s+━*─*\s+\d+%/);
    expect(plain(stdout)).not.toContain("Checking URLs 100%");
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
