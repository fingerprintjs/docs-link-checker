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
  getGithubBlobBaseUrl,
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
import { getErrorMessage } from "./utils/errors";
import { checkWebsite, createPrefixFilter } from "./website";

export const COMMANDS = ["site", "github-org", "files"] as const;
export type CommandName = (typeof COMMANDS)[number];

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
  hostConcurrency?: number;
  /** Allow requests to private and local addresses (SSRF guard off, see `src/destination.ts`) */
  allowPrivateHosts: boolean;
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
  --update-baseline          Add the current failures to the baseline file (default ${DEFAULT_BASELINE_FILE})
                             and exit with code 0. Existing entries are kept.
  --prune-baseline           With --update-baseline: also remove exact entries that no longer fail. Only for
                             runs that check everything the baseline covers (all files / pages, no sampling)
  --output-dir <dir>         Where to save the JSON and HTML reports (default: ${DEFAULT_OUTPUT_DIR})
  --json                     Print the JSON report to stdout (logs go to stderr)
  --host-concurrency <n>     Max concurrent requests per host (default: LINK_CHECK_HOST_CONCURRENCY or 8)
  --allow-private-hosts      Allow links to private and local addresses (localhost, 10.x, 169.254.x...), blocked by
                             default. Only for trusted documents, e.g. a local dev server
                             (default: LINK_CHECK_ALLOW_PRIVATE_HOSTS=true)
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
  LINK_CHECK_ALLOW_PRIVATE_HOSTS  "true" for --allow-private-hosts

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
  "prune-baseline": { type: "boolean" },
  "output-dir": { type: "string" },
  json: { type: "boolean" },
  "host-concurrency": { type: "string" },
  "allow-private-hosts": { type: "boolean" },
} as const;

type ParsedValues = ReturnType<
  typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>
>["values"];
type Env = Record<string, string | undefined>;

/** Options that only make sense for one command */
const COMMAND_OPTIONS = [
  ["include", "site"],
  ["use-playwright", "site"],
  ["dry-run", "files"],
  ["annotations", "files"],
] as const satisfies ReadonlyArray<readonly [keyof typeof OPTIONS, CommandName]>;

const isCommand = (value: string | undefined): value is CommandName =>
  COMMANDS.some((command) => command === value);

/** Runs a parser, turning its error into a `UsageError` (optionally renaming the env variable to the flag) */
const parseOrThrow = <T>(parse: () => T, [envName, flag]: [string?, string?] = []): T => {
  try {
    return parse();
  } catch (error) {
    const message = getErrorMessage(error);
    throw new UsageError(envName && flag ? message.replace(envName, flag) : message, {
      cause: error,
    });
  }
};

/** Options shared by all commands, also checks that no option of another command is used */
const parseCommonOptions = (
  command: CommandName,
  values: ParsedValues,
  env: Env,
): CommonOptions => {
  for (const [option, onlyFor] of COMMAND_OPTIONS) {
    if (values[option] !== undefined && onlyFor !== command) {
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
    sampleRateValue === undefined
      ? parseOrThrow(() => getSampleRate(env.LINK_CHECK_SAMPLE_RATE))
      : parseOrThrow(
          () => getSampleRate(sampleRateValue),
          ["LINK_CHECK_SAMPLE_RATE", "--sample-rate"],
        );
  const hostConcurrencyValue = values["host-concurrency"];
  const hostConcurrency =
    hostConcurrencyValue === undefined
      ? undefined
      : parseOrThrow(
          () => getHostConcurrencyLimit(hostConcurrencyValue),
          ["LINK_CHECK_HOST_CONCURRENCY", "--host-concurrency"],
        );
  if (hostConcurrency === undefined) {
    // Validate the environment variable early instead of failing on the first request
    parseOrThrow(() => getHostConcurrencyLimit(env.LINK_CHECK_HOST_CONCURRENCY));
  }
  const isUpdatingBaseline = values["update-baseline"] ?? false;
  const pruneBaseline = values["prune-baseline"] ?? false;
  if (pruneBaseline && !isUpdatingBaseline) {
    throw new UsageError("--prune-baseline can only be used with --update-baseline.");
  }
  if (pruneBaseline && sampleRate < 1) {
    throw new UsageError(
      "--prune-baseline needs a full run (sample rate 1), entries of pages that were not checked would be removed.",
    );
  }
  const allowPrivateHostsEnv = env.LINK_CHECK_ALLOW_PRIVATE_HOSTS;
  if (allowPrivateHostsEnv && allowPrivateHostsEnv !== "true" && allowPrivateHostsEnv !== "false") {
    throw new UsageError(
      `Invalid LINK_CHECK_ALLOW_PRIVATE_HOSTS "${allowPrivateHostsEnv}", expected "true" or "false".`,
    );
  }
  // An empty LINK_CHECK_BASELINE means no baseline
  const envBaseline = env.LINK_CHECK_BASELINE || undefined;
  const defaultBaseline = isUpdatingBaseline ? DEFAULT_BASELINE_FILE : undefined;
  return {
    sampleRate,
    failOnBroken: values["fail-on-broken"] ?? env.FAIL_ON_BROKEN_LINKS !== "false",
    baseline: values.baseline ?? envBaseline ?? defaultBaseline,
    updateBaseline: isUpdatingBaseline,
    pruneBaseline,
    outputDir: values["output-dir"] ?? DEFAULT_OUTPUT_DIR,
    json: values.json ?? false,
    allowPrivateHosts: values["allow-private-hosts"] ?? allowPrivateHostsEnv === "true",
    ...(hostConcurrency === undefined ? {} : { hostConcurrency }),
  };
};

const parseSiteCommand = (
  args: string[],
  values: ParsedValues,
  options: CommonOptions,
): CliCommand => {
  const [url] = args;
  if (url === undefined || args.length !== 1) {
    throw new UsageError(`site expects exactly one URL, got ${args.length}.`);
  }
  if (!URL.canParse(url)) {
    throw new UsageError(`Invalid URL "${url}".`);
  }
  const { protocol } = new URL(url);
  if (protocol !== "http:" && protocol !== "https:") {
    throw new UsageError(`Invalid URL "${url}", expected an http(s) URL.`);
  }
  const include = values.include ?? [];
  if (include.includes("")) {
    throw new UsageError("--include must not be empty.");
  }
  return {
    command: "site",
    url,
    include,
    usePlaywright: values["use-playwright"] ?? false,
    options,
  };
};

/**
 * Parses command line arguments (without `node` and the script). Environment variables are used as defaults.
 * @throws {UsageError} for unknown commands or options, missing arguments and invalid values
 */
export const parseCliArgs = (argv: string[], env: Env = process.env): CliCommand => {
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
    throw new UsageError(getErrorMessage(error), { cause: error });
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

  const options = parseCommonOptions(first, values, env);
  switch (first) {
    case "site":
      return parseSiteCommand(args, values, options);
    case "github-org": {
      const [org] = args;
      if (org === undefined || args.length !== 1) {
        throw new UsageError(`github-org expects exactly one organization, got ${args.length}.`);
      }
      if (!/^[A-Za-z\d](?:[A-Za-z\d-]*[A-Za-z\d])?$/.test(org)) {
        throw new UsageError(`Invalid GitHub organization "${org}".`);
      }
      return { command: "github-org", org, options };
    }
    case "files":
      if (args.length === 0) {
        throw new UsageError("files expects at least one glob pattern or file.");
      }
      return {
        command: "files",
        patterns: args,
        dryRun: values["dry-run"] ?? false,
        annotations: values.annotations ?? true,
        options,
      };
  }
};

type Output = (text: string) => void;

type RunContext = {
  env: Env;
  cwd: string;
  stdout: Output;
  stderr: Output;
};

type CheckCommand = Exclude<CliCommand, { command: "help" }>;

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
      return checkLocalFiles({
        patterns: command.patterns,
        cwd,
        sampleRate,
        baseline,
        outputDir,
        sourceBaseUrl: getGithubBlobBaseUrl(env, cwd),
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
  command: Extract<CliCommand, { command: "files" }>,
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

/**
 * Runs `fn` with the process set up for the options: with --json, console output goes to stderr; the destination
 * guard reads `LINK_CHECK_ALLOW_PRIVATE_HOSTS` (also in the browser route handler). Both are restored at the end.
 */
const withCliEnvironment = async <T>(options: CommonOptions, fn: () => Promise<T>): Promise<T> => {
  const originalConsole = globalThis.console;
  if (options.json) {
    // stdout only gets the JSON report: send all logs (console.log, console.table...) to stderr
    globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
  }
  const previousAllowPrivateHosts = process.env.LINK_CHECK_ALLOW_PRIVATE_HOSTS;
  process.env.LINK_CHECK_ALLOW_PRIVATE_HOSTS = String(options.allowPrivateHosts);
  if (options.allowPrivateHosts) {
    console.warn("Links to private and local addresses are allowed (--allow-private-hosts).");
  }
  try {
    return await fn();
  } finally {
    globalThis.console = originalConsole;
    if (previousAllowPrivateHosts === undefined) {
      delete process.env.LINK_CHECK_ALLOW_PRIVATE_HOSTS;
    } else {
      process.env.LINK_CHECK_ALLOW_PRIVATE_HOSTS = previousAllowPrivateHosts;
    }
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

  let command: CliCommand;
  try {
    command = parseCliArgs(argv, context.env);
  } catch (error) {
    if (error instanceof UsageError) {
      context.stderr(`Error: ${error.message}\nRun "${BIN} --help" for usage.\n`);
      return 2;
    }
    throw error;
  }
  if (command.command === "help") {
    context.stdout(`${getHelp(command.topic)}\n`);
    return 0;
  }

  const checkCommand = command;
  return withCliEnvironment(checkCommand.options, async () => {
    try {
      return await runCheckCommand(checkCommand, context);
    } catch (error) {
      context.stderr(
        `Error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      return 1;
    }
  });
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
