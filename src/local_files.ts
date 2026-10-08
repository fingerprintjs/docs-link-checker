/**
 * `files` command: finds markdown files, checks local links on the filesystem, external links over the network.
 * STUB: implemented by the PIPELINE group.
 */
import type { FileSystem } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Effect } from "effect";
import type { RunServices } from "./app";
import type { NoMarkdownFiles } from "./errors";
import type { Link, LinkCheckResult, LinkWithResult } from "./types";

/** Report name of the `files` command */
export const LOCAL_FILES_SITE_NAME = "local files";

export type CollectedLinks = {
  files: string[];
  /** Relative links and anchors, checked on the filesystem */
  local: Link[];
  /** Absolute links, checked over the network */
  external: Link[];
  /** Links with other schemes (`mailto:`...), not checked */
  skipped: Link[];
};

export type LocalCheckContext = {
  readonly root: string;
  readonly anchorsOf: (absolutePath: string) => Effect.Effect<Set<string>, PlatformError>;
};

export const checkLocalLink: (
  file: string,
  href: string,
  context: LocalCheckContext,
) => Effect.Effect<LinkCheckResult, never, FileSystem.FileSystem> = () =>
  Effect.die("not implemented");

export const collectLinksFromFiles: (args: {
  readonly patterns: ReadonlyArray<string>;
  readonly cwd: string;
  readonly sampleRate: number;
}) => Effect.Effect<CollectedLinks, NoMarkdownFiles | PlatformError, FileSystem.FileSystem> = () =>
  Effect.die("not implemented");

export const checkLocalFiles: (args: {
  readonly patterns: ReadonlyArray<string>;
  readonly cwd: string;
  readonly sampleRate: number;
}) => Effect.Effect<
  LinkWithResult[],
  NoMarkdownFiles | PlatformError,
  FileSystem.FileSystem | RunServices
> = () => Effect.die("not implemented");
