import { Console } from "node:console";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
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
import { checkReadmesInGithubOrg } from "./github/gh_get_links";
import {
  describeResult,
  getFileAnnotations,
  getGithubBlobBaseUrl,
  writeGithubOutputs,
  writeJobSummary,
} from "./github_actions";
import { parseHostConcurrency } from "./limiter";
import { checkLocalFiles, collectLinksFromFiles } from "./local_files";
import {
  DEFAULT_OUTPUT_DIR,
  getLinksToFix,
  getReportPaths,
  type LinkCheckReport,
} from "./report/report";
import { getSampleRate } from "./utils";
import { getErrorMessage } from "./utils/errors";
import { checkWebsite, createPrefixFilter } from "./website";

export type CommonOptions = {
  sampleRate: number;
  failOnBroken: boolean;
  /** Path of the baseline file, if any */
  baseline?: string;
  updateBaseline: boolean;
  /** With `updateBaseline`: also remove exact entries that no longer fail (only for full-scope runs) */
  pruneBaseline: boolean;
  outputDir: string;
  json: boolean;
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
      /** Print GitHub annotations (in GitHub Actions) or `file:line` problems */
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

const parseUrl = validated((value) => {
  if (!URL.canParse(value) || !/^https?:$/.test(new URL(value).protocol)) {
    throw new Error(`Invalid URL "${value}", expected an http(s) URL.`);
  }
  return value;
});

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
        "Check only a deterministic share of the pages / README files / markdown files",
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
        "--output-dir <dir>",
        "Where to save the JSON and HTML reports",
        nonEmpty,
        DEFAULT_OUTPUT_DIR,
      )
      .option("--json", "Print the JSON report to stdout (logs go to stderr)", false)
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
      baseline: options.baseline ?? (options.updateBaseline ? DEFAULT_BASELINE_FILE : undefined),
    };
  };

  addCommonOptions(
    program
      .command("site")
      .description(
        "Links on all pages of a website, found in its sitemap (sitemap.xml or robots.txt)",
      )
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
      .description("Links in local markdown files (.md, .markdown)")
      .argument("<glob...>", "Markdown files or globs (quote globs so the CLI expands them)")
      .option("--dry-run", "Only list the links found, don't check anything", false)
      .option(
        "--no-annotations",
        "Don't print links to fix as GitHub annotations (or file:line lines locally)",
      ),
  )
    .addHelpText(
      "after",
      `
.md and .markdown files are checked, node_modules and .git are skipped.
- Relative links (docs/a.md, ../b/, /root-relative.md, #anchor) are checked on the filesystem:
  the file or directory must exist, #anchors must match a heading in the markdown file.
- Absolute links (https://...) are checked over the network, like in the other commands.
In GitHub Actions, links to fix are reported as annotations on the files.

Examples:
  ${BIN} files "docs/**/*.md" README.md\n  ${BIN} files "**/*.md" --baseline ${DEFAULT_BASELINE_FILE}`,
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
  env: Env;
  cwd: string;
  stdout: Output;
  stderr: Output;
};

/** `file:line` (or just the file) of a link */
const formatLocation = (link: { page?: string; line?: number }) =>
  link.line ? `${link.page}:${link.line}` : link.page;

type CliIO = {
  env?: Env;
  cwd?: string;
  stdout?: Output;
  stderr?: Output;
};

const runCommand = (
  command: CheckCommand,
  baseline: Baseline,
  cwd: string,
  env: Env,
): Promise<LinkCheckReport> => {
  const { sampleRate, outputDir, hostConcurrency } = command.options;
  switch (command.command) {
    case "site":
      return checkWebsite({
        websiteUrl: command.url,
        linkFilter: command.include.length > 0 ? createPrefixFilter(command.include) : undefined,
        sampleRate,
        baseline,
        outputDir,
        hostConcurrency,
      });
    case "github-org":
      return checkReadmesInGithubOrg(command.org, {
        sampleRate,
        baseline,
        outputDir,
        hostConcurrency,
      });
    case "files":
      return checkLocalFiles({
        patterns: command.patterns,
        cwd,
        sampleRate,
        baseline,
        outputDir,
        sourceBaseUrl: getGithubBlobBaseUrl(env, cwd),
        hostConcurrency,
      });
  }
};

/** Local, compiler-like list of links to fix: `docs/a.md:7: broken link: docs/missing.md (File not found...)` */
export const formatFileProblems = (report: LinkCheckReport): string[] =>
  getLinksToFix(report).map((link) => {
    // One line per problem: collapse multi-line error details (HTTP bodies, Playwright messages)
    const result = describeResult(link).replace(/\s+/g, " ");
    const shortResult = result.length > 200 ? `${result.slice(0, 199)}…` : result;
    return `${formatLocation(link)}: ${link.href}: ${shortResult}`;
  });

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
const getExitCode = (linksToFix: number, options: CommonOptions): number => {
  if (linksToFix === 0) {
    return 0;
  }
  if (options.updateBaseline) {
    console.warn(`Found ${linksToFix} links to fix, added to the baseline.`);
    return 0;
  }
  if (options.failOnBroken) {
    console.error(`Found ${linksToFix} links to fix.`);
    return 1;
  }
  console.warn(
    `Found ${linksToFix} links to fix (not failing because of --no-fail-on-broken or FAIL_ON_BROKEN_LINKS=false).`,
  );
  return 0;
};

const runCheckCommand = async (command: CheckCommand, context: RunContext): Promise<number> => {
  const { options } = command;
  const { env, stdout, stderr } = context;

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
    await runDryRun(command, context);
    return 0;
  }

  const report = await runCommand(command, baseline, context.cwd, env);
  const reportPaths = getReportPaths(report.siteName, options.outputDir);
  const linksToFix = report.summary.totalLinksToFix;

  if (command.command === "files" && command.annotations) {
    // Workflow commands (annotations) are read from stdout, keep them off it only in --json mode
    const annotationOut = options.json ? stderr : stdout;
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
      // A run can check only part of what the baseline covers (file globs, --include, sampling),
      // entries are only removed when asked for
      prune: options.pruneBaseline,
    });
    writeBaseline(options.baseline, file);
    console.log(
      `Updated baseline ${options.baseline}: ${file.ignore.length} entries (was ${baseline.entries.length}).`,
    );
  }

  if (options.json) {
    stdout(`${JSON.stringify(report, null, 2)}\n`);
  }

  return getExitCode(linksToFix, options);
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
    env: io.env ?? process.env,
    cwd: io.cwd ?? process.cwd(),
    stdout: io.stdout ?? ((text: string) => process.stdout.write(text)),
    stderr: io.stderr ?? ((text: string) => process.stderr.write(text)),
  };

  let exitCode = 0;
  const run = (command: CheckCommand) =>
    withCliEnvironment(command.options, async () => {
      try {
        exitCode = await runCheckCommand(command, context);
      } catch (error) {
        context.stderr(
          `Error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
        );
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
