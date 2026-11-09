import { Console } from "node:console";
import { relative, resolve } from "node:path";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import {
  type Baseline,
  BaselineError,
  DEFAULT_BASELINE_FILE,
  EMPTY_BASELINE,
  loadBaseline,
  updateBaseline,
  writeBaseline,
} from "./baseline";
import { checkReadmesInGithubOrg, getGithubOrgSiteName, OrgListingError } from "./github/get_links";
import { getSampleRate } from "./parallel";
import { formatFileProblems, formatTargetGroups, formatVerdict } from "./report/cli";
import { loadPreviousReport } from "./report/compare";
import { formatLocation } from "./report/format";
import {
  getFileAnnotations,
  getGithubBlobBaseUrl,
  writeGithubOutputs,
  writeJobSummary,
} from "./report/github_actions";
import {
  DEFAULT_OUTPUT_DIR,
  getJSONReport,
  getLinksToFix,
  getReportPaths,
  type LinkCheckReport,
  saveReport,
} from "./report/report";
import { type RunDeps, withRun } from "./run";
import {
  checkLocalFiles,
  collectLinksFromFiles,
  LOCAL_FILES_SITE_NAME,
  NoFilesToCheckError,
} from "./sources/local_files";
import { checkWebsite, createPrefixFilter } from "./sources/website";
import { createTerminal, type Terminal } from "./terminal";
import type { LinkWithResult } from "./types";
import { getErrorMessage } from "./utils/errors";
import { parseHostConcurrency } from "./utils/limiter";

type CommonOptions = {
  sampleRate: number;
  failOnBroken: boolean;
  /** Path of the baseline file, if any */
  baseline?: string;
  updateBaseline: boolean;
  /** Path of a previous JSON report, the new report gets `diff` (new and fixed links to fix) against it */
  compare?: string;
  /** With `updateBaseline`: also remove exact entries that no longer fail (only for full-scope runs) */
  pruneBaseline: boolean;
  outputDir: string;
  /** Page listing all reports, linked from the HTML report */
  indexUrl?: string;
  json: boolean;
  /** Also show run metrics, timings and request details */
  verbose: boolean;
  hostConcurrency: number;
};

type CheckCommand =
  | {
      command: "site";
      url: string;
      include: string[];
      options: CommonOptions;
    }
  | { command: "github-org"; org: string; options: CommonOptions }
  | {
      command: "files";
      patterns: string[];
      dryRun: boolean;
      /** Print GitHub annotations (in GitHub Actions) or the list of problems */
      annotations: boolean;
      options: CommonOptions;
    };

const BIN = "docs-link-checker";

const ENV_HELP = `
Environment variables:
  GH_TOKEN                        GitHub token, used to check GitHub links with the API (required for github-org)
  FAIL_ON_BROKEN_LINKS            "false" to not fail on links to fix
  LINK_CHECK_SAMPLE_RATE          Default for --sample-rate
  LINK_CHECK_HOST_CONCURRENCY     Default for --host-concurrency
  LINK_CHECK_BASELINE             Default for --baseline
  LINK_CHECK_COMPARE              Default for --compare
  LINK_CHECK_INDEX_URL            Default for --index-url

Exit codes: 0 no links to fix (or not failing), 1 links to fix or the check crashed, 2 invalid arguments or baseline.`;

type Env = Record<string, string | undefined>;

/** Option or argument parser: rejects empty values, reports parse errors as invalid arguments */
const validated =
  <T>(parse: (value: string) => T, rename?: [envName: string, flag: string]) =>
  (value: string): T => {
    try {
      if (value.trim() === "") {
        throw new Error("must not be empty.");
      }
      return parse(value);
    } catch (error) {
      const message = getErrorMessage(error);
      throw new InvalidArgumentError(rename ? message.replace(...rename) : message);
    }
  };

const parseHttpUrl = (value: string, name = "URL") => {
  if (!URL.canParse(value) || !/^https?:$/.test(new URL(value).protocol)) {
    throw new Error(`Invalid ${name} "${value}", expected an http(s) URL.`);
  }
  return value;
};

const parseUrl = validated((value) => parseHttpUrl(value));

const parseOrg = validated((value) => {
  if (!/^[A-Za-z\d](?:[A-Za-z\d-]*[A-Za-z\d])?$/.test(value)) {
    throw new Error(`Invalid GitHub organization "${value}".`);
  }
  return value;
});

const nonEmpty = validated((value) => value);

const collect = (value: string, previous: string[]) => [...previous, nonEmpty(value)];

/**
 * Declares the commands and options.
 * Environment variables come from `env`, not `process.env` (`Option.env()`), so tests stay isolated.
 */
const buildProgram = (
  { env, stdout, stderr }: RunContext,
  run: (command: CheckCommand) => Promise<void>,
) => {
  const program = new Command(BIN)
    .description("Checks links, including #anchors, in documentation.")
    .exitOverride()
    .configureOutput({
      writeOut: stdout,
      writeErr: stderr,
      outputError: (message) =>
        stderr(`Error: ${message.replace(/^error: /, "")}Run "${BIN} --help" for usage.\n`),
    })
    .addHelpText("after", ENV_HELP);

  const addCommonOptions = (command: Command) =>
    command
      .option(
        "--sample-rate <0-1>",
        "Check only a deterministic share of the pages / README files / local files",
        validated(getSampleRate, ["LINK_CHECK_SAMPLE_RATE", "--sample-rate"]),
      )
      .option(
        "--fail-on-broken",
        "Exit with code 1 when links need fixing",
        env.FAIL_ON_BROKEN_LINKS !== "false",
      )
      .option("--no-fail-on-broken", "Only report links to fix")
      .option(
        "--baseline <file>",
        "Baseline (ignore) file with known false positives and accepted broken links, matching links are reported as ignored",
        nonEmpty,
        // An empty LINK_CHECK_BASELINE means no baseline
        env.LINK_CHECK_BASELINE || undefined,
      )
      .option(
        "--update-baseline",
        `Add the current failures to the baseline file (default ${DEFAULT_BASELINE_FILE}) and exit with code 0, existing entries are kept`,
        false,
      )
      .option(
        "--prune-baseline",
        "With --update-baseline: also remove exact entries that no longer fail, only for runs that check everything the baseline covers (all files / pages, no sampling)",
        false,
      )
      .option(
        "--compare <report.json>",
        "Previous JSON report: the report gets the number of new and fixed links to fix since then (skipped if the file is missing)",
        nonEmpty,
        // An empty LINK_CHECK_COMPARE means no comparison
        env.LINK_CHECK_COMPARE || undefined,
      )
      .option(
        "--output-dir <dir>",
        "Where to save the JSON and HTML reports",
        nonEmpty,
        DEFAULT_OUTPUT_DIR,
      )
      .option(
        "--index-url <url>",
        "Page listing all reports, linked from the HTML report",
        parseUrl,
      )
      .option("--json", "Print the JSON report to stdout (logs go to stderr)", false)
      .option("--verbose", "Also show run metrics, timings and request details", false)
      .option(
        "--host-concurrency <n>",
        "Max concurrent requests per host",
        validated(parseHostConcurrency, ["LINK_CHECK_HOST_CONCURRENCY", "--host-concurrency"]),
      )
      .addHelpText("after", ENV_HELP);

  /**
   * The common options, with the environment variables as defaults for the flags that are absent.
   * Env values are validated only when used, so `--help` and flags that override them still work.
   */
  const getCommonOptions = (command: Command): CommonOptions => {
    const options = command.opts<
      Omit<CommonOptions, "sampleRate" | "hostConcurrency"> &
        Partial<Pick<CommonOptions, "sampleRate" | "hostConcurrency">>
    >();
    const fromEnv = <T>(value: T | undefined, parse: () => T): T => {
      try {
        return value ?? parse();
      } catch (error) {
        return command.error(getErrorMessage(error));
      }
    };
    const sampleRate = fromEnv(options.sampleRate, () => getSampleRate(env.LINK_CHECK_SAMPLE_RATE));
    const hostConcurrency = fromEnv(options.hostConcurrency, () =>
      parseHostConcurrency(env.LINK_CHECK_HOST_CONCURRENCY),
    );
    // An empty LINK_CHECK_INDEX_URL means no link
    const indexUrl = fromEnv(options.indexUrl, () =>
      env.LINK_CHECK_INDEX_URL
        ? parseHttpUrl(env.LINK_CHECK_INDEX_URL, "LINK_CHECK_INDEX_URL")
        : undefined,
    );
    if (options.pruneBaseline && !options.updateBaseline) {
      command.error("--prune-baseline can only be used with --update-baseline.");
    }
    if (options.pruneBaseline && sampleRate < 1) {
      command.error(
        "--prune-baseline needs a full run (sample rate 1), entries of pages that were not checked would be removed.",
      );
    }
    return {
      ...options,
      sampleRate,
      hostConcurrency,
      indexUrl,
      baseline: options.baseline ?? (options.updateBaseline ? DEFAULT_BASELINE_FILE : undefined),
    };
  };

  addCommonOptions(
    program
      .command("site")
      .description("Links on all pages of a website, found in its sitemap")
      .argument("<url>", "Website URL", parseUrl)
      .option(
        "--include <prefix>",
        "Only check links starting with this prefix (repeatable)",
        collect,
        [],
      ),
  )
    .addHelpText(
      "after",
      `\nExample:\n  ${BIN} site https://fingerprint.com --include https://fingerprint.com --include https://github.com`,
    )
    .action((url: string, { include }: { include: string[] }, command: Command) =>
      run({ command: "site", url, include, options: getCommonOptions(command) }),
    );

  addCommonOptions(
    program
      .command("github-org")
      .description(
        "Links in README files of all public, non-archived repositories of a GitHub organization (needs GH_TOKEN)",
      )
      .argument("<org>", "GitHub organization", parseOrg),
  )
    .addHelpText("after", `\nExample:\n  ${BIN} github-org fingerprintjs`)
    .action((org: string, _options: unknown, command: Command) =>
      run({ command: "github-org", org, options: getCommonOptions(command) }),
    );

  addCommonOptions(
    program
      .command("files")
      .description("Links in local markdown files (.md, .markdown) and source code (.tsx, .js...)")
      .argument(
        "<glob...>",
        "Markdown or source code files or globs (quote globs so the CLI expands them)",
      )
      .option("--dry-run", "Only list the links found, don't check anything", false)
      .option(
        "--no-annotations",
        "Don't print links to fix as GitHub annotations (or as a list locally)",
      ),
  )
    .addHelpText(
      "after",
      `
.md and .markdown files are checked, node_modules and .git are skipped.
Source code (.js, .jsx, .ts, .tsx, .vue, .svelte, .astro, .html...): only absolute links (https://...).
- Relative links (docs/a.md, ../b/, /root-relative.md, #anchor) are checked on the filesystem:
  the file or directory must exist, #anchors must match a heading in the markdown file.
- Absolute links (https://...) are checked over the network, like in the other commands.
In GitHub Actions, links to fix are reported as annotations on the files.

Examples:
  ${BIN} files "docs/**/*.md" README.md\n  ${BIN} files "src/**/*.tsx"\n  ${BIN} files "**/*.md" --baseline ${DEFAULT_BASELINE_FILE}`,
    )
    .action(
      (
        patterns: string[],
        { dryRun, annotations }: { dryRun: boolean; annotations: boolean },
        command: Command,
      ) =>
        run({
          command: "files",
          patterns,
          dryRun,
          annotations,
          options: getCommonOptions(command),
        }),
    );

  return program;
};

type Output = (text: string) => void;

type RunContext = {
  /** The arguments of the command, shown in the header */
  argv: string[];
  env: Env;
  cwd: string;
  /** Redraw the progress line, defaults to whether the output stream is a TTY */
  tty?: boolean;
  stdout: Output;
  stderr: Output;
  deps?: RunDeps;
};

type CliIO = {
  tty?: boolean;
  env?: Env;
  cwd?: string;
  stdout?: Output;
  stderr?: Output;
  /** Replaces external dependencies of the run (tests) */
  deps?: RunDeps;
};

/** Checks the links of the command, `siteName` names the report */
const checkCommandLinks = async (
  command: CheckCommand,
  cwd: string,
): Promise<{ results: LinkWithResult[]; siteName: string }> => {
  const { sampleRate } = command.options;
  switch (command.command) {
    case "site":
      return {
        results: await checkWebsite({
          websiteUrl: command.url,
          linkFilter: command.include.length > 0 ? createPrefixFilter(command.include) : undefined,
          sampleRate,
        }),
        siteName: new URL(command.url).hostname,
      };
    case "github-org":
      return {
        results: await checkReadmesInGithubOrg(command.org, { sampleRate }),
        siteName: getGithubOrgSiteName(command.org),
      };
    case "files":
      return {
        results: await checkLocalFiles({ patterns: command.patterns, cwd, sampleRate }),
        siteName: LOCAL_FILES_SITE_NAME,
      };
  }
};

/**
 * Runs the check as a single run (see `withRun`) and does what all commands share:
 * builds and saves the report.
 */
const runCommand = (
  command: CheckCommand,
  baseline: Baseline,
  terminal: Terminal,
  { cwd, env, deps }: RunContext,
): Promise<LinkCheckReport> => {
  const { outputDir, hostConcurrency } = command.options;
  return withRun({ hostConcurrency, deps, terminal }, async () => {
    const startTime = performance.now();
    const { results, siteName } = await checkCommandLinks(command, cwd);
    const durationMs = Math.round(performance.now() - startTime);

    const report = getJSONReport({
      links: results,
      siteName,
      baseline,
      generatedAt: new Date(),
      durationMs,
      // Relative to `cwd` like the other paths
      previous: command.options.compare
        ? loadPreviousReport(resolve(cwd, command.options.compare))
        : undefined,
    });
    saveReport(report, outputDir, {
      sourceBaseUrl: command.command === "files" ? getGithubBlobBaseUrl(env, cwd) : undefined,
      indexUrl: command.options.indexUrl,
    });
    return report;
  });
};

/** `--dry-run` of the files command: lists the links found, checks nothing */
const runDryRun = async (
  command: Extract<CheckCommand, { command: "files" }>,
  { env, cwd, stdout }: RunContext,
) => {
  const { options } = command;
  const collected = await collectLinksFromFiles({
    patterns: command.patterns,
    cwd,
    sampleRate: options.sampleRate,
  });
  if (options.json) {
    stdout(`${JSON.stringify(collected, null, 2)}\n`);
  } else {
    const groups = [
      ["local", collected.local],
      ["external", collected.external],
      ["skipped", collected.skipped],
    ] as const;
    for (const [kind, links] of groups) {
      for (const link of links) {
        stdout(`${kind}\t${formatLocation(link)}\t${link.href}\n`);
      }
    }
    stdout(
      `${collected.files.length} files, ${collected.local.length} local, ${collected.external.length} external, ${collected.skipped.length} skipped links.\n`,
    );
  }
  writeGithubOutputs(
    { "local-links": collected.local.length, "external-links": collected.external.length },
    env.GITHUB_OUTPUT,
  );
};

/** Exit code for the links to fix: 1 only when failing on broken links and not updating the baseline */
const getExitCode = (linksToFix: number, options: CommonOptions): number =>
  linksToFix > 0 && options.failOnBroken && !options.updateBaseline ? 1 : 0;

/** Path relative to `cwd`, or absolute when it is outside of it */
const displayPath = (cwd: string, path: string) => {
  const absolute = resolve(cwd, path);
  const relativePath = relative(cwd, absolute);
  return relativePath.startsWith("..") ? absolute : relativePath;
};

/** Command and arguments as typed, globs and spaces quoted */
const formatArgs = (argv: string[]) =>
  argv.map((arg) => (/[\s*?{}[\]()$!'"]/.test(arg) ? JSON.stringify(arg) : arg)).join(" ");

/** The links to fix: the list of problems for `files`, grouped by target for the other commands */
const printLinksToFix = (
  command: CheckCommand,
  report: LinkCheckReport,
  { line, paint }: Terminal,
  env: Env,
) => {
  let lines: string[] = [];
  if (command.command === "site" || command.command === "github-org") {
    const siteOrigin = command.command === "site" ? new URL(command.url).origin : undefined;
    lines = formatTargetGroups(report, paint, siteOrigin);
  } else if (command.annotations) {
    // Workflow commands (annotations) are read from the log of the run, the list is for people at a terminal
    lines =
      env.GITHUB_ACTIONS === "true"
        ? getFileAnnotations(report)
        : formatFileProblems(report, paint);
  }
  for (const text of lines) {
    line(text);
  }
};

const runCheckCommand = async (command: CheckCommand, context: RunContext): Promise<number> => {
  const { options } = command;
  const { env, stdout, stderr } = context;

  // Relative to `cwd` like the file globs
  const baselinePath = options.baseline && resolve(context.cwd, options.baseline);
  let baseline = EMPTY_BASELINE;
  if (baselinePath) {
    try {
      baseline = loadBaseline(baselinePath, { allowMissing: options.updateBaseline });
    } catch (error) {
      if (error instanceof BaselineError) {
        stderr(`Error: ${error.message}\n`);
        return 2;
      }
      throw error;
    }
  }

  if (command.command === "files" && command.dryRun) {
    await runDryRun(command, context);
    return 0;
  }

  // With --json, stdout only gets the report
  const stream = options.json ? process.stderr : process.stdout;
  const terminal = createTerminal({
    write: options.json ? stderr : stdout,
    stream,
    tty: context.tty,
    verbose: options.verbose,
  });
  const { paint } = terminal;
  terminal.line(`${paint("bold", BIN)} ${paint("dim", formatArgs(context.argv))}`);
  if (baselinePath) {
    terminal.line(paint("dim", `Baseline ${options.baseline}, ${baseline.entries.length} entries`));
  }
  terminal.line();

  const report = await runCommand(command, baseline, terminal, context);
  const reportPaths = getReportPaths(report.siteName, options.outputDir);
  const linksToFix = report.summary.totalLinksToFix;

  terminal.line();
  printLinksToFix(command, report, terminal, env);
  writeJobSummary(report, {}, env.GITHUB_STEP_SUMMARY);
  writeGithubOutputs(
    {
      "links-to-fix": linksToFix,
      "report-path": reportPaths.json,
      "report-html-path": reportPaths.html,
    },
    env.GITHUB_OUTPUT,
  );

  if (options.updateBaseline && baselinePath) {
    const file = updateBaseline({
      baseline,
      failures: [...getLinksToFix(report), ...report.ignored],
      // A run can check only part of what the baseline covers (file globs, --include, sampling),
      // entries are only removed when asked for
      prune: options.pruneBaseline,
    });
    writeBaseline(baselinePath, file);
    terminal.line(
      paint(
        "dim",
        `Updated baseline ${options.baseline}: ${file.ignore.length} entries (was ${baseline.entries.length})`,
      ),
    );
  }

  const exitCode = getExitCode(linksToFix, options);
  for (const line of formatVerdict(report, paint, {
    htmlPath: displayPath(context.cwd, reportPaths.html),
    baselineHint: !options.updateBaseline,
    notFailing: exitCode === 0 && !options.updateBaseline,
  })) {
    terminal.line(line);
  }

  if (options.json) {
    stdout(`${JSON.stringify(report, null, 2)}\n`);
  }

  return exitCode;
};

/** Runs `fn` with the process set up for the options: with --json, console output goes to stderr (restored at the end) */
const withCliEnvironment = async <T>(options: CommonOptions, fn: () => Promise<T>): Promise<T> => {
  const originalConsole = globalThis.console;
  if (options.json) {
    // stdout only gets the JSON report: send all logs (console.log, console.table...) to stderr
    globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
  }
  try {
    return await fn();
  } finally {
    globalThis.console = originalConsole;
  }
};

/**
 * Runs the CLI. Never throws: errors are printed and turned into the exit code.
 * @returns the exit code (0 ok, 1 links to fix or crash, 2 invalid arguments or baseline)
 */
export const runCli = async (argv: string[], io: CliIO = {}): Promise<number> => {
  const context: RunContext = {
    argv,
    tty: io.tty,
    env: io.env ?? process.env,
    cwd: io.cwd ?? process.cwd(),
    stdout: io.stdout ?? ((text: string) => process.stdout.write(text)),
    stderr: io.stderr ?? ((text: string) => process.stderr.write(text)),
    deps: io.deps,
  };

  let exitCode = 0;
  const run = (command: CheckCommand) =>
    withCliEnvironment(command.options, async () => {
      try {
        exitCode = await runCheckCommand(command, context);
      } catch (error) {
        // Expected failures are explained by the message, a stack trace would only add noise
        let text = String(error);
        if (error instanceof NoFilesToCheckError || error instanceof OrgListingError) {
          text = error.message;
        } else if (error instanceof Error) {
          text = error.stack ?? error.message;
        }
        context.stderr(`Error: ${text}\n`);
        exitCode = 1;
      }
    });

  try {
    await buildProgram(context, run).parseAsync(argv, { from: "user" });
  } catch (error) {
    // Help (exit code 0) and usage errors are already printed by commander
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? 0 : 2;
    }
    throw error;
  }
  return exitCode;
};
