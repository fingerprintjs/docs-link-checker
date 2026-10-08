/**
 * Command line: commander parses, one Effect runs the command and returns the exit code
 * (0 ok, 1 links to fix or crash, 2 usage or baseline error, 130 interrupted).
 * STUB: `runCliEffect` and `runCli` are implemented by the CLI group.
 */
import type { FileSystem } from "@effect/platform";
import { Effect, type Layer } from "effect";
import type { RunServices, RunSettings } from "./app";
import { describeResult } from "./github_actions";
import { getLinksToFix, type LinkCheckReport } from "./report/report";

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

/**
 * Never fails: returns the exit code. Output only through `Console` and the logger.
 * Env and `.env` come from the ambient `ConfigProvider`.
 */
export const runCliEffect: (
  argv: ReadonlyArray<string>,
  options?: CliOptions,
) => Effect.Effect<number, never, FileSystem.FileSystem> = () => Effect.die("not implemented");

/** Production wiring used by `bin`: NodeFileSystem, `.env`, SIGINT/SIGTERM abort (exit code 130) */
export const runCli: (argv: string[]) => Promise<number> = () =>
  Promise.reject(new Error("not implemented"));
