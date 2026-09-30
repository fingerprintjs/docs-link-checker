import { Console } from "node:console";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  type Baseline,
  BaselineError,
  DEFAULT_BASELINE_FILE,
  EMPTY_BASELINE,
  loadBaseline,
  updateBaseline,
  writeBaseline,
} from "./baseline";
import { checkReadmesInGithubOrg } from "./github/gh_get_links";
import {
  describeResult,
  getFileAnnotations,
  writeGithubOutputs,
  writeJobSummary,
} from "./github_actions";
import { checkLocalFiles, collectLinksFromFiles } from "./local_files";
import {
  DEFAULT_OUTPUT_DIR,
  getLinksToFix,
  getReportPaths,
  type LinkCheckReport,
} from "./report/report";
import { getHostConcurrencyLimit, getSampleRate } from "./utils";
import { checkWebsite, createPrefixFilter } from "./website";

export const COMMANDS = ["site", "github-org", "files"] as const;
export type CommandName = (typeof COMMANDS)[number];

export type CommonOptions = {
  sampleRate: number;
  failOnBroken: boolean;
  /** Path of the baseline file, if any */
  baseline?: string;
  updateBaseline: boolean;
  outputDir: string;
  json: boolean;
  hostConcurrency?: number;
};

export type CliCommand =
  | { command: "help"; topic?: CommandName }
  | {
      command: "site";
      url: string;
      include: string[];
      usePlaywright: boolean;
      options: CommonOptions;
    }
  | { command: "github-org"; org: string; options: CommonOptions }
  | {
      command: "files";
      patterns: string[];
      dryRun: boolean;
      /** Print GitHub annotations (in GitHub Actions) or `file:line` problems */
      annotations: boolean;
      options: CommonOptions;
    };

/** Invalid command line arguments or environment variables (exit code 2) */
export class UsageError extends Error {
  override name = "UsageError";
}

const BIN = "docs-link-checker";

const COMMON_HELP = `Common options:
  --sample-rate <0-1>        Check only a deterministic share of the pages / README files / markdown files
                             (default: LINK_CHECK_SAMPLE_RATE or 1)
  --fail-on-broken           Exit with code 1 when links need fixing (default, unless FAIL_ON_BROKEN_LINKS=false)
  --no-fail-on-broken        Only report links to fix
  --baseline <file>          Baseline (ignore) file with known false positives and accepted broken links
                             (default: LINK_CHECK_BASELINE). Matching links are reported as ignored.
  --update-baseline          Write the current failures to the baseline file (default ${DEFAULT_BASELINE_FILE})
                             and exit with code 0
  --output-dir <dir>         Where to save the JSON and HTML reports (default: ${DEFAULT_OUTPUT_DIR})
  --json                     Print the JSON report to stdout (logs go to stderr)
  --host-concurrency <n>     Max concurrent requests per host (default: LINK_CHECK_HOST_CONCURRENCY or 8)
  -h, --help                 Show help`;

const HELP: Record<"main" | CommandName, string> = {
  main: `Checks links, including #anchors, in documentation.

Usage:
  ${BIN} site <url> [--include <prefix>...] [options]   Links on all pages of a website (from its sitemap)
  ${BIN} github-org <org> [options]                     Links in README files of an organization's public repositories
  ${BIN} files <glob...> [options]                      Links in local markdown files
  ${BIN} <command> --help                               Help for a command

${COMMON_HELP}

Environment variables:
  GH_TOKEN                     GitHub token, used to check GitHub links with the API (required for github-org)
  FAIL_ON_BROKEN_LINKS         "false" to not fail on links to fix
  LINK_CHECK_SAMPLE_RATE       Default for --sample-rate
  LINK_CHECK_HOST_CONCURRENCY  Default for --host-concurrency
  LINK_CHECK_BASELINE          Default for --baseline

Exit codes: 0 no links to fix (or not failing), 1 links to fix or the check crashed, 2 invalid arguments or baseline.`,
  site: `Checks links on all pages of a website, found in its sitemap (sitemap.xml or robots.txt).

Usage:
  ${BIN} site <url> [--include <prefix>...] [--use-playwright] [options]

Options:
  --include <prefix>         Only check links starting with this prefix (repeatable)
  --use-playwright           Extract links from pages with a browser (client-side rendered pages)

${COMMON_HELP}

Example:
  ${BIN} site https://fingerprint.com --include https://fingerprint.com --include https://github.com`,
  "github-org": `Checks links in README files of all public, non-archived repositories of a GitHub organization.
Needs a GH_TOKEN environment variable.

Usage:
  ${BIN} github-org <org> [options]

${COMMON_HELP}

Example:
  ${BIN} github-org fingerprintjs`,
  files: `Checks links in local markdown files (.md, .markdown). node_modules and .git are skipped.
- Relative links (docs/a.md, ../b/, /root-relative.md, #anchor) are checked on the filesystem:
  the file or directory must exist, #anchors must match a heading in the markdown file.
- Absolute links (https://...) are checked over the network, like in the other commands.
In GitHub Actions, links to fix are reported as annotations on the files.

Usage:
  ${BIN} files <glob...> [--dry-run] [--no-annotations] [options]

Options:
  --dry-run                  Only list the links found, don't check anything
  --no-annotations           Don't print links to fix as GitHub annotations (or file:line lines locally)

${COMMON_HELP}

Examples:
  ${BIN} files "docs/**/*.md" README.md
  ${BIN} files "**/*.md" --baseline ${DEFAULT_BASELINE_FILE}`,
};

export const getHelp = (topic?: CommandName) => HELP[topic ?? "main"];

const OPTIONS = {
  help: { type: "boolean", short: "h" },
  include: { type: "string", multiple: true },
  "use-playwright": { type: "boolean" },
  "dry-run": { type: "boolean" },
  annotations: { type: "boolean" },
  "sample-rate": { type: "string" },
  "fail-on-broken": { type: "boolean" },
  baseline: { type: "string" },
  "update-baseline": { type: "boolean" },
  "output-dir": { type: "string" },
  json: { type: "boolean" },
  "host-concurrency": { type: "string" },
} as const;

/** Options that only make sense for one command */
const COMMAND_OPTIONS: Partial<Record<keyof typeof OPTIONS, CommandName>> = {
  include: "site",
  "use-playwright": "site",
  "dry-run": "files",
  annotations: "files",
};

const isCommand = (value: string | undefined): value is CommandName =>
  COMMANDS.includes(value as CommandName);

/** Runs a parser, turning its error into a `UsageError` (optionally renaming the env variable to the flag) */
const parseOrThrow = <T>(parse: () => T, [envName, flag]: [string?, string?] = []): T => {
  try {
    return parse();
  } catch (error) {
    const message = (error as Error).message;
    throw new UsageError(envName && flag ? message.replace(envName, flag) : message);
  }
};

/**
 * Parses command line arguments (without `node` and the script). Environment variables are used as defaults.
 * @throws {UsageError} for unknown commands or options, missing arguments and invalid values
 */
export const parseCliArgs = (
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): CliCommand => {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      allowNegative: true,
      strict: true,
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { values, positionals } = parsed;
  const [first, ...args] = positionals;

  if (first === "help") {
    return { command: "help", topic: isCommand(args[0]) ? args[0] : undefined };
  }
  if (values.help) {
    return { command: "help", topic: isCommand(first) ? first : undefined };
  }
  if (first === undefined) {
    throw new UsageError("Missing command.");
  }
  if (!isCommand(first)) {
    throw new UsageError(`Unknown command "${first}", expected one of: ${COMMANDS.join(", ")}.`);
  }
  const command = first;

  for (const [option, onlyFor] of Object.entries(COMMAND_OPTIONS)) {
    if (values[option as keyof typeof values] !== undefined && onlyFor !== command) {
      throw new UsageError(`--${option} can only be used with the ${onlyFor} command.`);
    }
  }

  for (const option of ["sample-rate", "host-concurrency", "output-dir", "baseline"] as const) {
    if (values[option]?.trim() === "") {
      throw new UsageError(`--${option} must not be empty.`);
    }
  }
  const sampleRateValue = values["sample-rate"];
  const sampleRate =
    sampleRateValue !== undefined
      ? parseOrThrow(
          () => getSampleRate(sampleRateValue),
          ["LINK_CHECK_SAMPLE_RATE", "--sample-rate"],
        )
      : parseOrThrow(() => getSampleRate(env.LINK_CHECK_SAMPLE_RATE));
  const hostConcurrencyValue = values["host-concurrency"];
  const hostConcurrency =
    hostConcurrencyValue !== undefined
      ? parseOrThrow(
          () => getHostConcurrencyLimit(hostConcurrencyValue),
          ["LINK_CHECK_HOST_CONCURRENCY", "--host-concurrency"],
        )
      : undefined;
  if (hostConcurrency === undefined) {
    // Validate the environment variable early instead of failing on the first request
    parseOrThrow(() => getHostConcurrencyLimit(env.LINK_CHECK_HOST_CONCURRENCY));
  }
  const updateBaseline = values["update-baseline"] ?? false;
  const baseline =
    values.baseline ??
    (env.LINK_CHECK_BASELINE ? env.LINK_CHECK_BASELINE : undefined) ??
    (updateBaseline ? DEFAULT_BASELINE_FILE : undefined);
  const options: CommonOptions = {
    sampleRate,
    failOnBroken: values["fail-on-broken"] ?? env.FAIL_ON_BROKEN_LINKS !== "false",
    baseline,
    updateBaseline,
    outputDir: values["output-dir"] || DEFAULT_OUTPUT_DIR,
    json: values.json ?? false,
    ...(hostConcurrency !== undefined ? { hostConcurrency } : {}),
  };

  switch (command) {
    case "site": {
      if (args.length !== 1) {
        throw new UsageError(`site expects exactly one URL, got ${args.length}.`);
      }
      const [url] = args;
      let protocol: string;
      try {
        protocol = new URL(url).protocol;
      } catch {
        throw new UsageError(`Invalid URL "${url}".`);
      }
      if (protocol !== "http:" && protocol !== "https:") {
        throw new UsageError(`Invalid URL "${url}", expected an http(s) URL.`);
      }
      const include = values.include ?? [];
      if (include.some((prefix) => prefix === "")) {
        throw new UsageError("--include must not be empty.");
      }
      return {
        command,
        url,
        include,
        usePlaywright: values["use-playwright"] ?? false,
        options,
      };
    }
    case "github-org": {
      if (args.length !== 1) {
        throw new UsageError(`github-org expects exactly one organization, got ${args.length}.`);
      }
      const [org] = args;
      if (!/^[A-Za-z\d](?:[A-Za-z\d-]*[A-Za-z\d])?$/.test(org)) {
        throw new UsageError(`Invalid GitHub organization "${org}".`);
      }
      return { command, org, options };
    }
    case "files": {
      if (args.length === 0) {
        throw new UsageError("files expects at least one glob pattern or file.");
      }
      return {
        command,
        patterns: args,
        dryRun: values["dry-run"] ?? false,
        annotations: values.annotations ?? true,
        options,
      };
    }
  }
};

type CliIO = {
  env?: Record<string, string | undefined>;
  cwd?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
};

const runCommand = (
  command: Exclude<CliCommand, { command: "help" }>,
  baseline: Baseline,
  cwd: string,
): Promise<LinkCheckReport> => {
  const { sampleRate, outputDir } = command.options;
  switch (command.command) {
    case "site":
      return checkWebsite({
        websiteUrl: command.url,
        linkFilter: command.include.length > 0 ? createPrefixFilter(command.include) : undefined,
        usePlaywright: command.usePlaywright,
        sampleRate,
        baseline,
        outputDir,
      });
    case "github-org":
      return checkReadmesInGithubOrg(command.org, { sampleRate, baseline, outputDir });
    case "files":
      return checkLocalFiles({ patterns: command.patterns, cwd, sampleRate, baseline, outputDir });
  }
};

/** Local, compiler-like list of links to fix: `docs/a.md:7: broken link: docs/missing.md (File not found...)` */
export const formatFileProblems = (report: LinkCheckReport): string[] =>
  getLinksToFix(report).map((link) => {
    // One line per problem: collapse multi-line error details (HTTP bodies, Playwright messages)
    const result = describeResult(link).replace(/\s+/g, " ");
    const shortResult = result.length > 200 ? `${result.slice(0, 199)}…` : result;
    return `${link.line ? `${link.page}:${link.line}` : link.page}: ${link.href}: ${shortResult}`;
  });

/**
 * Runs the CLI. Never throws: errors are printed and turned into the exit code.
 * @returns the exit code (0 ok, 1 links to fix or crash, 2 invalid arguments or baseline)
 */
export const runCli = async (argv: string[], io: CliIO = {}): Promise<number> => {
  const env = io.env ?? process.env;
  const cwd = io.cwd ?? process.cwd();
  const stdout = io.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = io.stderr ?? ((text: string) => process.stderr.write(text));

  let command: CliCommand;
  try {
    command = parseCliArgs(argv, env);
  } catch (error) {
    if (error instanceof UsageError) {
      stderr(`Error: ${error.message}\nRun "${BIN} --help" for usage.\n`);
      return 2;
    }
    throw error;
  }
  if (command.command === "help") {
    stdout(`${getHelp(command.topic)}\n`);
    return 0;
  }

  const { options } = command;
  // With --json, stdout only gets the JSON report: send all logs (console.log, console.table...) to stderr
  const originalConsole = globalThis.console;
  if (options.json) {
    globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
  }
  // Workflow commands (annotations) are read from stdout, keep them off it only in --json mode
  const annotationOut = options.json ? stderr : stdout;

  try {
    if (options.hostConcurrency !== undefined) {
      // Read when the shared per-host limiter is created (on the first request)
      process.env.LINK_CHECK_HOST_CONCURRENCY = String(options.hostConcurrency);
    }

    let baseline = EMPTY_BASELINE;
    if (options.baseline) {
      try {
        baseline = loadBaseline(options.baseline, { allowMissing: options.updateBaseline });
      } catch (error) {
        if (error instanceof BaselineError) {
          stderr(`Error: ${error.message}\n`);
          return 2;
        }
        throw error;
      }
      console.log(`Using baseline ${options.baseline} (${baseline.entries.length} entries).`);
    }

    if (command.command === "files" && command.dryRun) {
      const collected = await collectLinksFromFiles({
        patterns: command.patterns,
        cwd,
        sampleRate: options.sampleRate,
      });
      if (options.json) {
        stdout(`${JSON.stringify(collected, null, 2)}\n`);
      } else {
        for (const [kind, links] of [
          ["local", collected.local],
          ["external", collected.external],
          ["skipped", collected.skipped],
        ] as const) {
          for (const link of links) {
            stdout(
              `${kind}\t${link.line ? `${link.page}:${link.line}` : link.page}\t${link.href}\n`,
            );
          }
        }
        stdout(
          `${collected.files.length} files, ${collected.local.length} local, ${collected.external.length} external, ${collected.skipped.length} skipped links.\n`,
        );
      }
      writeGithubOutputs(
        {
          "local-links": collected.local.length,
          "external-links": collected.external.length,
        },
        env.GITHUB_OUTPUT,
      );
      return 0;
    }

    const report = await runCommand(command, baseline, cwd);
    const reportPaths = getReportPaths(report.siteName, options.outputDir);
    const linksToFix = report.summary.totalLinksToFix;

    if (command.command === "files" && command.annotations) {
      const problems =
        env.GITHUB_ACTIONS === "true" ? getFileAnnotations(report) : formatFileProblems(report);
      for (const line of problems) {
        annotationOut(`${line}\n`);
      }
    }
    writeJobSummary(report, { reportPaths }, env.GITHUB_STEP_SUMMARY);
    writeGithubOutputs(
      {
        "links-to-fix": linksToFix,
        "report-path": reportPaths.json,
        "report-html-path": reportPaths.html,
      },
      env.GITHUB_OUTPUT,
    );

    if (options.updateBaseline && options.baseline) {
      const file = updateBaseline({
        baseline,
        failures: [...getLinksToFix(report), ...report.ignored],
        // With sampling, entries for pages that were not checked are not stale
        keepUnmatched: options.sampleRate < 1,
      });
      writeBaseline(options.baseline, file);
      console.log(
        `Updated baseline ${options.baseline}: ${file.ignore.length} entries (was ${baseline.entries.length}).`,
      );
    }

    if (options.json) {
      stdout(`${JSON.stringify(report, null, 2)}\n`);
    }

    if (linksToFix > 0) {
      if (options.updateBaseline) {
        console.warn(`Found ${linksToFix} links to fix, added to the baseline.`);
      } else if (options.failOnBroken) {
        console.error(`Found ${linksToFix} links to fix.`);
        return 1;
      } else {
        console.warn(
          `Found ${linksToFix} links to fix (not failing because of --no-fail-on-broken or FAIL_ON_BROKEN_LINKS=false).`,
        );
      }
    }
    return 0;
  } catch (error) {
    stderr(`Error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return 1;
  } finally {
    globalThis.console = originalConsole;
  }
};

const isMainModule = () => {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
};

if (isMainModule()) {
  process.exitCode = await runCli(process.argv.slice(2));
}
