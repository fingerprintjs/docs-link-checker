/**
 * `files` command: checks the links in local markdown files. Relative links and anchors are checked on the
 * filesystem, absolute links with the usual `checkLinks` pipeline.
 */
import { glob } from "node:fs/promises"; // oxlint-disable-line no-restricted-imports -- `FileSystem` has no glob
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { FileSystem } from "@effect/platform";
import { SystemError, type PlatformError } from "@effect/platform/Error";
import { Effect, Option } from "effect";
import { getErrorMessage, NoMarkdownFiles } from "./errors";
import { safeDecode } from "./github/gh_url";
import { decodeHash } from "./hash";
import { checkLineAnchor, countLines, parseLineAnchor } from "./line_anchor";
import { checkLinks } from "./link";
import { extractMarkdownLinks, getMarkdownAnchors, hasMatchingAnchor } from "./markdown";
import { Metrics } from "./metrics";
import { filterOutIrrelevantLinks } from "./page";
import type { Link, LinkCheckResult, LinkWithResult } from "./types";
import { compareStrings, sampleItems } from "./utils";

/** Report name of the `files` command */
export const LOCAL_FILES_SITE_NAME = "local files";

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const IGNORED_DIRECTORIES = new Set(["node_modules", ".git"]);

const isMarkdownFile = (path: string) => MARKDOWN_EXTENSIONS.has(extname(path).toLowerCase());

/** Relative path with `/` separators (used as the page of local links, in reports and annotations) */
const toPosixPath = (path: string) => path.split(sep).join("/");

const globMatches = (pattern: string, cwd: string) =>
  Effect.tryPromise({
    try: async () => {
      const matches: string[] = [];
      for await (const match of glob(pattern, {
        cwd,
        exclude: (path) => IGNORED_DIRECTORIES.has(basename(path)),
      })) {
        matches.push(match);
      }
      return matches;
    },
    catch: (cause) =>
      new SystemError({
        reason: "Unknown",
        module: "FileSystem",
        method: "glob",
        pathOrDescriptor: pattern,
        cause,
      }),
  });

/**
 * Expands glob patterns (and plain file paths) to markdown files, relative to `cwd`, sorted and deduplicated.
 * `node_modules` and `.git` are skipped, non-markdown files are ignored.
 */
const findMarkdownFiles = (patterns: ReadonlyArray<string>, cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = new Set<string>();
    for (const pattern of patterns) {
      for (const match of yield* globMatches(pattern, cwd)) {
        const absolutePath = resolve(cwd, match);
        if (isMarkdownFile(absolutePath) && (yield* fs.stat(absolutePath)).type === "File") {
          files.add(toPosixPath(relative(cwd, absolutePath)));
        }
      }
    }
    return [...files].toSorted(compareStrings);
  });

type LinkKind = "local" | "external" | "skip";

/**
 * - `external`: `http(s)://` and protocol-relative (`//host/path`) links, checked over the network.
 * - `skip`: other schemes (`mailto:`, `tel:`, `data:`...) and empty links.
 * - `local`: everything else (relative paths, root-relative paths, `#anchors`), checked on the filesystem.
 */
const getLinkKind = (href: string): LinkKind => {
  if (href.trim() === "") return "skip";
  if (/^https?:\/\//i.test(href) || href.startsWith("//")) return "external";
  if (/^[a-z][a-z\d+.-]*:/i.test(href)) return "skip";
  return "local";
};

export type LocalCheckContext = {
  /** Root for root-relative links (`/docs/a.md`), usually the repository root */
  readonly root: string;
  /** Markdown anchors of a file (absolute path). Pass a cached function so each file is parsed once. */
  readonly anchorsOf: (absolutePath: string) => Effect.Effect<Set<string>, PlatformError>;
};

// Supported README names (compared case-insensitively), in order of preference
const README_NAMES = ["readme.md", "readme.markdown"];

/**
 * The README GitHub renders for a directory: `README.md` or `README.markdown` in any case (`readme.md`,
 * `Readme.markdown`...). Deterministic when there are several: `.md` first, then by name in code point order
 * (`README.md` before `Readme.md` before `readme.md`). Directories with such names are ignored, symlinks to files
 * are followed (callers check that they stay inside the repository before reading them).
 */
const findReadme = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const names = (yield* fs.readDirectory(directory)).filter((name) =>
      README_NAMES.includes(name.toLowerCase()),
    );
    // `stat` follows symlinks, a broken one fails and is not a candidate
    const candidates = yield* Effect.filter(names, (name) =>
      fs.stat(join(directory, name)).pipe(
        Effect.map((info) => info.type === "File"),
        Effect.orElseSucceed(() => false),
      ),
    );
    const [first] = candidates.toSorted(
      (a, b) =>
        README_NAMES.indexOf(a.toLowerCase()) - README_NAMES.indexOf(b.toLowerCase()) ||
        compareStrings(a, b),
    );
    return first === undefined ? undefined : join(directory, first);
  });

/** Is `path` the root or inside it (lexically, `path` and `root` are absolute) */
const isInsideRoot = (root: string, path: string): boolean => {
  const fromRoot = relative(root, path);
  return (
    fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
  );
};

/** Is the real path (symlinks resolved) of an existing `path` inside the real path of `root` */
const isRealPathInsideRoot = (root: string, path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return isInsideRoot(yield* fs.realPath(root), yield* fs.realPath(path));
  }).pipe(Effect.orElseSucceed(() => false));

/** `#anchor` in a markdown file must match a heading (or HTML anchor), with or without GitHub's prefix */
const checkMarkdownAnchor = (
  markdownFile: string,
  hash: string,
  { root, anchorsOf }: LocalCheckContext,
) =>
  Effect.gen(function* () {
    const anchors = yield* anchorsOf(markdownFile);
    if (hasMatchingAnchor(anchors, decodeHash(hash).toLowerCase())) {
      return { ok: true, status: 200 } satisfies LinkCheckResult;
    }
    return {
      ok: false,
      error: "hash not found",
      status: 200,
      errorDetail: `No heading matching #${hash} in ${toPosixPath(relative(root, markdownFile))}`,
    } satisfies LinkCheckResult;
  });

/**
 * Checks a local link (relative path, root-relative path or `#anchor`) found in `file`:
 * the target file or directory must exist, `#anchors` in markdown files must match a heading (or HTML anchor).
 * The query string is ignored. Never fails: unreadable files are "unexpected error" results.
 */
export const checkLocalLink = (
  file: string,
  href: string,
  context: LocalCheckContext,
): Effect.Effect<LinkCheckResult, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { root } = context;
    const hashIndex = href.indexOf("#");
    const pathAndQuery = hashIndex === -1 ? href : href.slice(0, hashIndex);
    const hash = hashIndex === -1 ? "" : href.slice(hashIndex + 1);
    const path = safeDecode(pathAndQuery.split("?", 1)[0] ?? "");

    let target = file;
    if (path !== "") {
      target = path.startsWith("/") ? join(root, path) : resolve(dirname(file), path);
    }
    // A link can't point to a file outside the checked repository (`../../../etc/passwd`): reject it before touching
    // the filesystem, so files of the machine running the check are never read and can't make such a link pass
    const outside: LinkCheckResult = {
      ok: false,
      error: "broken link",
      errorDetail: `Link points outside the repository: ${path}`,
    };
    if (!isInsideRoot(root, target)) {
      return outside;
    }
    const displayTarget = toPosixPath(relative(root, target)) || ".";

    const stats = yield* fs.stat(target).pipe(Effect.option);
    if (Option.isNone(stats)) {
      return {
        ok: false,
        error: "broken link",
        errorDetail: `File not found: ${displayTarget}`,
      } satisfies LinkCheckResult;
    }
    // Symlinks inside the repository must not point outside of it either
    if (!(yield* isRealPathInsideRoot(root, target))) {
      return outside;
    }

    if (!hash || hash === "/") {
      return { ok: true, status: 200 } satisfies LinkCheckResult;
    }
    if (hash.includes(":~:")) {
      return { ok: true, status: 200, note: "Text Fragment" } satisfies LinkCheckResult;
    }

    if (stats.value.type === "Directory") {
      // GitHub renders the README of a directory, anchors point to its headings
      const readme = yield* findReadme(target);
      if (!readme) {
        return {
          ok: true,
          status: 200,
          note: "Hash not checked (directory without README)",
        } satisfies LinkCheckResult;
      }
      return (yield* isRealPathInsideRoot(root, readme))
        ? yield* checkMarkdownAnchor(readme, hash, context)
        : outside;
    }
    if (isMarkdownFile(target)) {
      return yield* checkMarkdownAnchor(target, hash, context);
    }
    // GitHub line links (`#L10`, `#L10-L20`) on code files: the file must have enough lines
    const lineResult = parseLineAnchor(hash)
      ? checkLineAnchor(hash, countLines(yield* fs.readFileString(target)), displayTarget)
      : undefined;
    return (
      lineResult ??
      ({
        ok: true,
        status: 200,
        note: "Hash not checked (not a markdown file)",
      } satisfies LinkCheckResult)
    );
  }).pipe(
    Effect.catchAll((error) =>
      Effect.succeed<LinkCheckResult>({
        ok: false,
        error: "unexpected error",
        errorDetail: getErrorMessage(error),
      }),
    ),
  );

type CollectedLinks = {
  files: string[];
  /** Relative links and anchors, checked on the filesystem */
  local: Link[];
  /** Absolute links, checked over the network */
  external: Link[];
  /** Links with other schemes (`mailto:`...), not checked */
  skipped: Link[];
};

/**
 * Finds markdown files matching `patterns` (relative to `cwd`) and extracts their links, grouped by kind.
 * Fails with `NoMarkdownFiles` if nothing matches (probably a typo, checking nothing would pass silently).
 */
export const collectLinksFromFiles = Effect.fn("localFiles.collectLinksFromFiles")(function* ({
  patterns,
  cwd,
  sampleRate,
}: {
  readonly patterns: ReadonlyArray<string>;
  readonly cwd: string;
  readonly sampleRate: number;
}) {
  const fs = yield* FileSystem.FileSystem;
  const allFiles = yield* findMarkdownFiles(patterns, cwd);
  if (allFiles.length === 0) {
    return yield* new NoMarkdownFiles({ patterns });
  }
  const files = yield* sampleItems({
    items: allFiles,
    key: (file) => file,
    rate: sampleRate,
    label: "files",
  });
  const collected: CollectedLinks = { files, local: [], external: [], skipped: [] };
  for (const file of files) {
    const markdown = yield* fs.readFileString(resolve(cwd, file));
    for (const { href, text, line } of extractMarkdownLinks(markdown)) {
      const kind = getLinkKind(href);
      const link: Link = {
        page: file,
        // Protocol-relative links (`//example.com`) are checked over https
        href: kind === "external" && href.startsWith("//") ? `https:${href}` : href,
        text,
        ...(line ? { line } : {}),
      };
      if (kind === "local") collected.local.push(link);
      else if (kind === "external") collected.external.push(link);
      else collected.skipped.push(link);
    }
  }
  return collected;
});

/**
 * Checks links in local markdown files: relative links and anchors on the filesystem,
 * absolute links with the usual `checkLinks` pipeline (fetch, GitHub API, Playwright).
 * `cwd` is the directory the patterns and root-relative links (`/docs/a.md`) are resolved against.
 */
export const checkLocalFiles = Effect.fn("localFiles.checkLocalFiles")(function* ({
  patterns,
  cwd,
  sampleRate,
}: {
  readonly patterns: ReadonlyArray<string>;
  readonly cwd: string;
  readonly sampleRate: number;
}) {
  const fs = yield* FileSystem.FileSystem;
  const metrics = yield* Metrics;
  const root = resolve(cwd);
  const collected = yield* metrics.timePhase(
    "Extract links",
    collectLinksFromFiles({ patterns, cwd: root, sampleRate }),
  );
  yield* Effect.logInfo(
    `Found ${collected.local.length + collected.external.length} links in ${collected.files.length} files ` +
      `(${collected.local.length} local, ${collected.external.length} external, ${collected.skipped.length} skipped).`,
  );

  // Each markdown file is parsed once, however many links point into it
  const anchorsOf = yield* Effect.cachedFunction((path: string) =>
    fs.readFileString(path).pipe(Effect.map(getMarkdownAnchors)),
  );
  const localResults = yield* Effect.forEach(collected.local, (link) =>
    Effect.gen(function* () {
      const result = yield* checkLocalLink(resolve(root, link.page), link.href, {
        root,
        anchorsOf,
      });
      return { ...link, result };
    }),
  );

  const externalLinks = filterOutIrrelevantLinks(collected.external);
  const externalResults: LinkWithResult[] =
    externalLinks.length > 0 ? yield* checkLinks({ links: externalLinks }) : [];
  return [...localResults, ...externalResults];
});
