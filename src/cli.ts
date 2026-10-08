/**
 * Command line: commander parses (sync, no side effects), one Effect runs the command and returns the exit code
 * (0 ok, 1 links to fix or crash, 2 usage or baseline error, 130 interrupted).
 * - Env defaults of options are read with `Config` and parsed only when the flag is absent, so `--help` and flags
 *   that override an invalid variable still work.
 * - Usage text and errors of commander are buffered and printed through `Console`, so tests can capture them.
 * - Why not `@effect/cli`: docs/architecture.md.
 */
import { resolve } from "node:path";
import { inspect } from "node:util";
import type { FileSystem } from "@effect/platform";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { Cause, Clock, Console, Effect, Either, Exit, type Layer } from "effect";
import { liveRunLayer, type RunServices, type RunSettings } from "./app";
import {
  type Baseline,
  DEFAULT_BASELINE_FILE,
  EMPTY_BASELINE,
  loadBaseline,
  updateBaseline,
  writeBaseline,
} from "./baseline";
import {
  ActionsEnvConfig,
  type ActionsEnv,
  DEFAULT_HOST_CONCURRENCY,
  EnvOptions,
  loadDotEnv,
  parseHostConcurrency,
  parseSampleRate,
} from "./config";
import { UsageError } from "./errors";
import { checkReadmesInGithubOrg, getGithubOrgSiteName } from "./github/gh_get_links";
import {
  describeResult,
  getFileAnnotations,
  getGithubBlobBaseUrl,
  writeGithubOutputs,
  writeJobSummary,
} from "./github_actions";
import { checkLocalFiles, collectLinksFromFiles, LOCAL_FILES_SITE_NAME } from "./local_files";
import { LogLayer } from "./logger";
import {
  DEFAULT_OUTPUT_DIR,
  getJSONReport,
  getLinksToFix,
  getReportPaths,
  type LinkCheckReport,
  saveReport,
} from "./report/report";
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

/** Options as given on the command line: what is absent is decided later (environment, defaults) */
type Flags = Omit<CommonOptions, "sampleRate" | "failOnBroken" | "hostConcurrency" | "baseline"> &
  Partial<Pick<CommonOptions, "sampleRate" | "failOnBroken" | "hostConcurrency" | "baseline">>;

type CheckCommand =
  | { command: "site"; url: string; include: string[] }
  | { command: "github-org"; org: string }
  | {
      command: "files";
      patterns: string[];
      dryRun: boolean;
      /** Print GitHub annotations (in GitHub Actions) or `file:line` problems */
      annotations: boolean;
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

/** Option or argument parser for commander: rejects empty values, a `Left` is an invalid argument */
const argument =
  <T>(parse: (value: string) => Either.Either<T, string>) =>
  (value: string): T => {
    if (value.trim() === "") {
      throw new InvalidArgumentError("must not be empty.");
    }
    return Either.getOrThrowWith(parse(value), (message) => new InvalidArgumentError(message));
  };

const parseUrl = argument((value) =>
  URL.canParse(value) && /^https?:$/.test(new URL(value).protocol)
    ? Either.right(value)
    : Either.left(`Invalid URL "${value}", expected an http(s) URL.`),
);

const parseOrg = argument((value) =>
  /^[A-Za-z\d](?:[A-Za-z\d-]*[A-Za-z\d])?$/.test(value)
    ? Either.right(value)
    : Either.left(`Invalid GitHub organization "${value}".`),
);

const nonEmpty = argument((value) => Either.right(value));

const collect = (value: string, previous: string[]) => [...previous, nonEmpty(value)];

type CommanderOutput = Array<{ readonly stream: "out" | "err"; readonly text: string }>;

/** Declares the commands and options. `run` receives the parsed command, nothing is executed here. */
const buildProgram = (
  output: CommanderOutput,
  run: (command: CheckCommand, flags: Flags) => void,
) => {
  const program = new Command(BIN)
    .description("Checks links, including #anchors, in documentation.")
    .exitOverride()
    .configureOutput({
      writeOut: (text) => output.push({ stream: "out", text }),
      writeErr: (text) => output.push({ stream: "err", text }),
      outputError: (message) =>
        output.push({
          stream: "err",
          text: `Error: ${message.replace(/^error: /, "")}Run "${BIN} --help" for usage.\n`,
        }),
    })
    .addHelpText("after", ENV_HELP);

  // No defaults from the environment here (see the module comment)
  const addCommonOptions = (command: Command) =>
    command
      .option(
        "--sample-rate <0-1>",
        "Check only a deterministic share of the pages / README files / markdown files",
        argument((value) => parseSampleRate(value, "--sample-rate")),
      )
      .option("--fail-on-broken", "Exit with code 1 when links need fixing")
      .option("--no-fail-on-broken", "Only report links to fix")
      .option(
        "--baseline <file>",
        "Baseline (ignore) file with known false positives and accepted broken links, matching links are reported as ignored",
        nonEmpty,
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
        argument((value) => parseHostConcurrency(value, "--host-concurrency")),
      )
      .addHelpText("after", ENV_HELP);

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
      run({ command: "site", url, include }, command.opts<Flags>()),
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
      run({ command: "github-org", org }, command.opts<Flags>()),
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
      ) => run({ command: "files", patterns, dryRun, annotations }, command.opts<Flags>()),
    );

  return program;
};

type Parsed =
  | { readonly kind: "exit"; readonly exitCode: number }
  | { readonly kind: "run"; readonly command: CheckCommand; readonly flags: Flags };

/** Help and usage errors are exits: commander printed them into `output` already */
const parseArguments = (
  argv: ReadonlyArray<string>,
): { output: CommanderOutput; parsed: Parsed } => {
  const output: CommanderOutput = [];
  let parsed: Parsed = { kind: "exit", exitCode: 0 };
  const program = buildProgram(output, (command, flags) => {
    parsed = { kind: "run", command, flags };
  });
  try {
    program.parse(argv, { from: "user" });
  } catch (error) {
    if (!(error instanceof CommanderError)) {
      throw error;
    }
    parsed = { kind: "exit", exitCode: error.exitCode === 0 ? 0 : 2 };
  }
  return { output, parsed };
};

/** Commander text ends with a newline, `Console` adds one */
const printCommanderOutput = (output: CommanderOutput) =>
  Effect.forEach(
    output,
    ({ stream, text }) => {
      const line = text.replace(/\n$/, "");
      return stream === "out" ? Console.log(line) : Console.error(line);
    },
    { discard: true },
  );

/**
 * Flags over environment variables over defaults. Environment values are validated only when used.
 * Error text is the one of commander for flags: `Error: <message>` + usage hint.
 */
const resolveOptions = (flags: Flags): Effect.Effect<CommonOptions, UsageError> =>
  Effect.gen(function* () {
    const env = yield* EnvOptions.pipe(Effect.orDie);
    const fromEnv = <T>(args: {
      flag: T | undefined;
      name: string;
      raw: string;
      defaultValue: T;
      parse: (value: string, label: string) => Either.Either<T, string>;
    }) =>
      args.flag !== undefined || args.raw.trim() === ""
        ? Effect.succeed(args.flag ?? args.defaultValue)
        : Either.match(args.parse(args.raw, args.name), {
            onLeft: (message) => Effect.fail(new UsageError({ message })),
            onRight: Effect.succeed,
          });
    const sampleRate = yield* fromEnv({
      flag: flags.sampleRate,
      name: "LINK_CHECK_SAMPLE_RATE",
      raw: env.sampleRate,
      defaultValue: 1,
      parse: parseSampleRate,
    });
    const hostConcurrency = yield* fromEnv({
      flag: flags.hostConcurrency,
      name: "LINK_CHECK_HOST_CONCURRENCY",
      raw: env.hostConcurrency,
      defaultValue: DEFAULT_HOST_CONCURRENCY,
      parse: parseHostConcurrency,
    });
    if (flags.pruneBaseline && !flags.updateBaseline) {
      return yield* new UsageError({
        message: "--prune-baseline can only be used with --update-baseline.",
      });
    }
    if (flags.pruneBaseline && sampleRate < 1) {
      return yield* new UsageError({
        message:
          "--prune-baseline needs a full run (sample rate 1), entries of pages that were not checked would be removed.",
      });
    }
    // An empty LINK_CHECK_BASELINE means no baseline
    const baseline = flags.baseline ?? (env.baseline || undefined);
    return {
      ...flags,
      sampleRate,
      hostConcurrency,
      failOnBroken: flags.failOnBroken ?? env.failOnBroken !== "false",
      baseline: baseline ?? (flags.updateBaseline ? DEFAULT_BASELINE_FILE : undefined),
    };
  });

/** `file:line` (or just the file) of a link */
const formatLocation = (link: { page?: string; line?: number }) =>
  link.line ? `${link.page}:${link.line}` : link.page;

/** Local, compiler-like list of links to fix: `docs/a.md:7: broken link: docs/missing.md (File not found...)` */
export const formatFileProblems = (report: LinkCheckReport): string[] =>
  getLinksToFix(report).map((link) => {
    // One line per problem: collapse multi-line error details (HTTP bodies, Playwright messages)
    const result = describeResult(link).replace(/\s+/g, " ");
    const shortResult = result.length > 200 ? `${result.slice(0, 199)}…` : result;
    return `${formatLocation(link)}: ${link.href}: ${shortResult}`;
  });

export type CliOptions = {
  /** Default `process.cwd()`: globs, baseline, root-relative links */
  readonly cwd?: string;
  /** Default `liveRunLayer`, tests pass fakes */
  readonly runLayer?: (settings: RunSettings) => Layer.Layer<RunServices>;
};

/** Checks the links of the command, `siteName` names the report */
const checkCommandLinks = (command: CheckCommand, sampleRate: number, cwd: string) => {
  switch (command.command) {
    case "site":
      return checkWebsite({
        websiteUrl: command.url,
        linkFilter: command.include.length > 0 ? createPrefixFilter(command.include) : undefined,
        sampleRate,
      }).pipe(Effect.map((results) => ({ results, siteName: new URL(command.url).hostname })));
    case "github-org":
      return checkReadmesInGithubOrg(command.org, { sampleRate }).pipe(
        Effect.map((results) => ({ results, siteName: getGithubOrgSiteName(command.org) })),
      );
    case "files":
      return checkLocalFiles({ patterns: command.patterns, cwd, sampleRate }).pipe(
        Effect.map((results) => ({ results, siteName: LOCAL_FILES_SITE_NAME })),
      );
  }
};

type RunContext = {
  readonly command: CheckCommand;
  readonly options: CommonOptions;
  readonly cwd: string;
  readonly actions: ActionsEnv;
  readonly runLayer: NonNullable<CliOptions["runLayer"]>;
};

/** `--dry-run` of the files command: lists the links found, checks nothing */
const runDryRun = (
  command: Extract<CheckCommand, { command: "files" }>,
  { options, cwd, actions }: RunContext,
) =>
  Effect.gen(function* () {
    const collected = yield* collectLinksFromFiles({
      patterns: command.patterns,
      cwd,
      sampleRate: options.sampleRate,
    });
    if (options.json) {
      yield* Console.log(JSON.stringify(collected, null, 2));
    } else {
      const groups = [
        ["local", collected.local],
        ["external", collected.external],
        ["skipped", collected.skipped],
      ] as const;
      for (const [kind, links] of groups) {
        for (const link of links) {
          yield* Console.log(`${kind}\t${formatLocation(link)}\t${link.href}`);
        }
      }
      yield* Console.log(
        `${collected.files.length} files, ${collected.local.length} local, ${collected.external.length} external, ${collected.skipped.length} skipped links.`,
      );
    }
    yield* writeGithubOutputs(
      { "local-links": collected.local.length, "external-links": collected.external.length },
      actions.output,
    );
  });

/** Exit code for the links to fix: 1 only when failing on broken links and not updating the baseline */
const getExitCode = (linksToFix: number, options: CommonOptions) =>
  Effect.gen(function* () {
    if (linksToFix === 0) {
      return 0;
    }
    if (options.updateBaseline) {
      yield* Effect.logWarning(`Found ${linksToFix} links to fix, added to the baseline.`);
      return 0;
    }
    if (options.failOnBroken) {
      yield* Effect.logError(`Found ${linksToFix} links to fix.`);
      return 1;
    }
    yield* Effect.logWarning(
      `Found ${linksToFix} links to fix (not failing because of --no-fail-on-broken or FAIL_ON_BROKEN_LINKS=false).`,
    );
    return 0;
  });

/**
 * Checks the links with a fresh run layer (metrics, per-host limits, caches, browser: closed at the end, the
 * metrics summary is logged then). Builds and saves the report, logs the summary and the duration.
 */
const checkAndSaveReport = (
  { command, options, cwd, actions, runLayer }: RunContext,
  baseline: Baseline,
) =>
  Effect.gen(function* () {
    const start = yield* Clock.currentTimeMillis;
    const { results, siteName } = yield* checkCommandLinks(command, options.sampleRate, cwd);

    const report = getJSONReport({ links: results, siteName, baseline });
    yield* saveReport(report, options.outputDir, {
      sourceBaseUrl: command.command === "files" ? getGithubBlobBaseUrl(actions, cwd) : undefined,
    });
    // Same text as `console.log(object)`
    yield* Effect.logInfo(inspect(report.summary));
    yield* Effect.logInfo(
      `Finished in ${((yield* Clock.currentTimeMillis) - start) / 1000} seconds.`,
    );
    return report;
  }).pipe(Effect.provide(runLayer({ hostConcurrency: options.hostConcurrency })));

const runCheckCommand = (input: Omit<RunContext, "actions">) =>
  Effect.gen(function* () {
    const actions = yield* ActionsEnvConfig.pipe(Effect.orDie);
    const context: RunContext = { ...input, actions };
    const { command, options, cwd } = context;

    // Relative to `cwd` like the file globs
    const baselinePath = options.baseline && resolve(cwd, options.baseline);
    let baseline = EMPTY_BASELINE;
    if (baselinePath) {
      baseline = yield* loadBaseline(baselinePath, { allowMissing: options.updateBaseline });
      yield* Effect.logInfo(
        `Using baseline ${options.baseline} (${baseline.entries.length} entries).`,
      );
    }

    if (command.command === "files" && command.dryRun) {
      yield* runDryRun(command, context);
      return 0;
    }

    const report = yield* checkAndSaveReport(context, baseline);
    const reportPaths = getReportPaths(report.siteName, options.outputDir);
    const linksToFix = report.summary.totalLinksToFix;

    if (command.command === "files" && command.annotations) {
      const problems =
        actions.actions === "true" ? getFileAnnotations(report) : formatFileProblems(report);
      for (const line of problems) {
        // Workflow commands (annotations) are read from stdout, keep them off it only in --json mode
        yield* options.json ? Console.error(line) : Console.log(line);
      }
    }
    yield* writeJobSummary(report, { reportPaths }, actions.stepSummary);
    yield* writeGithubOutputs(
      {
        "links-to-fix": linksToFix,
        "report-path": reportPaths.json,
        "report-html-path": reportPaths.html,
      },
      actions.output,
    );

    if (options.updateBaseline && baselinePath) {
      const file = updateBaseline({
        baseline,
        failures: [...getLinksToFix(report), ...report.ignored],
        // A run can check only part of what the baseline covers (file globs, --include, sampling),
        // entries are only removed when asked for
        prune: options.pruneBaseline,
      });
      yield* writeBaseline(baselinePath, file);
      yield* Effect.logInfo(
        `Updated baseline ${options.baseline}: ${file.ignore.length} entries (was ${baseline.entries.length}).`,
      );
    }

    if (options.json) {
      yield* Console.log(JSON.stringify(report, null, 2));
    }

    return yield* getExitCode(linksToFix, options);
  });

const describeFailure = (error: unknown) =>
  Console.error(
    `Error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );

/**
 * Never fails: errors are printed and turned into the exit code.
 * Env and `.env` come from the ambient `ConfigProvider`.
 */
export const runCliEffect = (
  argv: ReadonlyArray<string>,
  { cwd = process.cwd(), runLayer = liveRunLayer }: CliOptions = {},
): Effect.Effect<number, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const { output, parsed } = parseArguments(argv);
    yield* printCommanderOutput(output);
    if (parsed.kind === "exit") {
      return parsed.exitCode;
    }
    const options = yield* resolveOptions(parsed.flags).pipe(
      Effect.catchTag("UsageError", (error) =>
        Console.error(`Error: ${error.message}\nRun "${BIN} --help" for usage.`).pipe(
          Effect.as(undefined),
        ),
      ),
    );
    if (!options) {
      return 2;
    }
    return yield* runCheckCommand({ command: parsed.command, options, cwd, runLayer }).pipe(
      // With --json, all logs go to stderr: stdout is only the report
      Effect.provide(LogLayer({ json: options.json })),
    );
  }).pipe(
    Effect.catchTag("BaselineError", (error) =>
      Console.error(`Error: ${error.message}`).pipe(Effect.as(2)),
    ),
    Effect.catchAll((error) => describeFailure(error).pipe(Effect.as(1))),
    Effect.catchAllDefect((defect) => describeFailure(defect).pipe(Effect.as(1))),
  );

/** Production wiring used by `bin`: NodeFileSystem, `.env`, SIGINT/SIGTERM abort (exit code 130) */
export const runCli = async (argv: string[]): Promise<number> => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  const program = Effect.gen(function* () {
    const dotEnv = yield* loadDotEnv;
    return yield* runCliEffect(argv).pipe(Effect.withConfigProvider(dotEnv));
  }).pipe(Effect.provide(NodeFileSystem.layer));
  try {
    const exit = await Effect.runPromiseExit(program, { signal: controller.signal });
    if (Exit.isSuccess(exit)) {
      return exit.value;
    }
    return Cause.isInterruptedOnly(exit.cause) ? 130 : 1;
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
};
