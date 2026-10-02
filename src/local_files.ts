import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { glob } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { marked, type Token, type Tokens } from "marked";
import { type Baseline, EMPTY_BASELINE } from "./baseline";
import { getMarkdownAnchors } from "./github/checks/gh_blob";
import { decodeHash } from "./hash";
import { checkLinks } from "./link";
import { filterOutIrrelevantLinks } from "./page";
import { getJSONReport, saveReport } from "./report/report";
import { withRun } from "./run";
import { timePhase } from "./run_context";
import type { Link, LinkCheckResult, LinkWithResult } from "./types";
import { compareStrings, sampleItems } from "./utils";

const LOCAL_FILES_SITE_NAME = "local files";

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const IGNORED_DIRECTORIES = new Set(["node_modules", ".git"]);

const isMarkdownFile = (path: string) => MARKDOWN_EXTENSIONS.has(extname(path).toLowerCase());

/** Relative path with `/` separators (used as the page of local links, in reports and annotations) */
const toPosixPath = (path: string) => path.split(sep).join("/");

/**
 * Expands glob patterns (and plain file paths) to markdown files, relative to `cwd`, sorted and deduplicated.
 * `node_modules` and `.git` are skipped, non-markdown files are ignored.
 */
export const findMarkdownFiles = async (patterns: string[], cwd: string): Promise<string[]> => {
  const files = new Set<string>();
  for (const pattern of patterns) {
    for await (const match of glob(pattern, {
      cwd,
      exclude: (path) => IGNORED_DIRECTORIES.has(basename(path)),
    })) {
      const absolutePath = resolve(cwd, match);
      if (isMarkdownFile(absolutePath) && statSync(absolutePath).isFile()) {
        files.add(toPosixPath(relative(cwd, absolutePath)));
      }
    }
  }
  return [...files].toSorted();
};

export type MarkdownLink = { href: string; text: string; line?: number };

// `Token` includes a generic token with any `type`, so checking `type` alone does not narrow it
const isLinkToken = (token: Token): token is Tokens.Link => token.type === "link";

const stripFormatting = (text: string) => text.replace(/\*\*|__|\*|_|~~|`/g, "");

/** Offsets of the line starts, to convert an offset to a 1-based line number */
const getLineStarts = (source: string): number[] => {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") starts.push(i + 1);
  }
  return starts;
};

const lineAt = (lineStarts: number[], offset: number): number => {
  let [low, high] = [0, lineStarts.length - 1];
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((lineStarts[middle] ?? 0) <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low + 1;
};

/**
 * Extracts links from markdown with the line they are on. Uses the marked lexer (like `extractLinksFromMarkdown`),
 * so links in code blocks are ignored. Tokens have no positions, so the line is found by searching the raw link
 * text in the source, in document order. Links whose raw text can't be found have no line.
 */
export const extractMarkdownLinks = (markdown: string): MarkdownLink[] => {
  // marked normalizes line endings, do the same so raw token text can be found in the source
  const source = markdown.replace(/\r\n?/g, "\n");
  const lineStarts = getLineStarts(source);
  const links: MarkdownLink[] = [];
  let cursor = 0;

  const findLine = (raw: string): number | undefined => {
    // Links inside blockquotes and lists can span lines that were re-indented by the lexer, search the first line
    const candidates = [raw, raw.split("\n", 1)[0] ?? raw];
    for (const candidate of candidates) {
      const offset = source.indexOf(candidate, cursor);
      if (offset !== -1) {
        cursor = offset + candidate.length;
        return lineAt(lineStarts, offset);
      }
    }
    return undefined;
  };

  // The callback is synchronous, walkTokens returns its (empty) results
  void marked.walkTokens(marked.lexer(source), (token: Token) => {
    if (isLinkToken(token)) {
      links.push({
        href: token.href,
        text: stripFormatting(token.text),
        line: findLine(token.raw),
      });
    }
  });
  return links;
};

export type LinkKind = "local" | "external" | "skip";

/**
 * - `external`: `http(s)://` and protocol-relative (`//host/path`) links, checked over the network.
 * - `skip`: other schemes (`mailto:`, `tel:`, `data:`...) and empty links.
 * - `local`: everything else (relative paths, root-relative paths, `#anchors`), checked on the filesystem.
 */
/** The group of `CollectedLinks` each kind of link goes to */
const LINK_GROUPS = {
  local: "local",
  external: "external",
  skip: "skipped",
} as const satisfies Record<LinkKind, keyof CollectedLinks>;

export const getLinkKind = (href: string): LinkKind => {
  if (href.trim() === "") return "skip";
  if (/^https?:\/\//i.test(href) || href.startsWith("//")) return "external";
  if (/^[a-z][a-z\d+.-]*:/i.test(href)) return "skip";
  return "local";
};

const decodePath = (path: string) => {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
};

const GITHUB_LINE_HASH = /^L(\d+)(?:C\d+)?(?:-L(\d+)(?:C\d+)?)?$/;
// GitHub prefixes ids in rendered markdown with `user-content-`, links work both with and without it
const USER_CONTENT_PREFIX = "user-content-";

type LocalCheckContext = {
  /** Root for root-relative links (`/docs/a.md`), usually the repository root */
  root: string;
  /** Markdown anchors by absolute file path, each file is parsed once */
  anchorCache?: Map<string, Set<string>>;
};

const getAnchorsOfFile = (path: string, cache?: Map<string, Set<string>>): Set<string> => {
  let anchors = cache?.get(path);
  if (!anchors) {
    anchors = getMarkdownAnchors(readFileSync(path, "utf8"));
    cache?.set(path, anchors);
  }
  return anchors;
};

/** Does the symlink point to a file (callers check that it stays inside the repository before reading it) */
const isFileTarget = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

// Supported README names (compared case-insensitively), in order of preference
const README_NAMES = ["readme.md", "readme.markdown"];

/**
 * The README GitHub renders for a directory: `README.md` or `README.markdown` in any case (`readme.md`,
 * `Readme.markdown`...). Deterministic when there are several: `.md` first, then by name in code point order
 * (`README.md` before `Readme.md` before `readme.md`). Directories with such names are ignored, symlinks to files are followed.
 */
export const findReadme = (directory: string): string | undefined => {
  const candidates = readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        README_NAMES.includes(entry.name.toLowerCase()) &&
        (entry.isFile() || (entry.isSymbolicLink() && isFileTarget(join(directory, entry.name)))),
    )
    .map((entry) => entry.name)
    .toSorted(
      (a, b) =>
        README_NAMES.indexOf(a.toLowerCase()) - README_NAMES.indexOf(b.toLowerCase()) ||
        compareStrings(a, b),
    );
  const [first] = candidates;
  return first === undefined ? undefined : join(directory, first);
};

/** Is `path` the root or inside it (lexically, `path` and `root` are absolute) */
const isInsideRoot = (root: string, path: string): boolean => {
  const fromRoot = relative(root, path);
  return (
    fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
  );
};

/** Is the real path (symlinks resolved) of an existing `path` inside the real path of `root` */
const isRealPathInsideRoot = (root: string, path: string): boolean => {
  try {
    return isInsideRoot(realpathSync(root), realpathSync(path));
  } catch {
    return false;
  }
};

const hashNotFound = (errorDetail: string): LinkCheckResult => ({
  ok: false,
  error: "hash not found",
  status: 200,
  errorDetail,
});

/** Splits a local link into its decoded path (without the query string) and its hash (without `#`) */
const parseLocalHref = (href: string): { path: string; hash: string } => {
  const hashIndex = href.indexOf("#");
  const pathAndQuery = hashIndex === -1 ? href : href.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : href.slice(hashIndex + 1);
  return { path: decodePath(pathAndQuery.split("?", 1)[0] ?? ""), hash };
};

/** Absolute path of the link target: the file itself (`#anchor`), root-relative or relative to the file */
const resolveLocalTarget = (file: string, path: string, root: string): string => {
  if (path === "") {
    return file;
  }
  return path.startsWith("/") ? join(root, path) : resolve(dirname(file), path);
};

/** GitHub line links (`#L10`, `#L10-L20`) on code files: the file must have enough lines */
const checkLineAnchor = (target: string, hash: string, displayTarget: string): LinkCheckResult => {
  const lineMatch = GITHUB_LINE_HASH.exec(hash);
  if (!lineMatch) {
    return { ok: true, status: 200, note: "Hash not checked (not a markdown file)" };
  }
  // Line numbers are 1-based, a range goes forward (`#L0`, `#L5-L0`, `#L9-L3` are not valid anchors)
  const firstLine = Number(lineMatch[1]);
  const lastLine = lineMatch[2] === undefined ? firstLine : Number(lineMatch[2]);
  if (firstLine < 1 || lastLine < firstLine) {
    return hashNotFound(`Invalid line anchor #${hash} (lines start at 1, ranges go forward)`);
  }
  const lineCount = readFileSync(target, "utf8").replace(/\n$/, "").split("\n").length;
  return lastLine <= lineCount
    ? { ok: true, status: 200 }
    : hashNotFound(`${displayTarget} has only ${lineCount} lines`);
};

/** `#anchor` in a markdown file must match a heading (or HTML anchor), with or without GitHub's prefix */
const checkMarkdownAnchor = (
  markdownFile: string,
  hash: string,
  { root, anchorCache }: LocalCheckContext,
): LinkCheckResult => {
  const anchor = decodeHash(hash).toLowerCase();
  const anchors = getAnchorsOfFile(markdownFile, anchorCache);
  const withoutPrefix = anchor.startsWith(USER_CONTENT_PREFIX)
    ? anchor.slice(USER_CONTENT_PREFIX.length)
    : anchor;
  if (anchors.has(anchor) || anchors.has(withoutPrefix)) {
    return { ok: true, status: 200 };
  }
  return hashNotFound(
    `No heading matching #${hash} in ${toPosixPath(relative(root, markdownFile))}`,
  );
};

/** Checks the hash of a link to a directory: GitHub renders its README, anchors point to its headings */
const checkDirectoryAnchor = (
  directory: string,
  hash: string,
  context: LocalCheckContext,
  outside: LinkCheckResult,
): LinkCheckResult => {
  const readme = findReadme(directory);
  if (!readme) {
    return { ok: true, status: 200, note: "Hash not checked (directory without README)" };
  }
  if (!isRealPathInsideRoot(context.root, readme)) {
    return outside;
  }
  return checkMarkdownAnchor(readme, hash, context);
};

/**
 * Checks a local link (relative path, root-relative path or `#anchor`) found in `file`:
 * the target file or directory must exist, `#anchors` in markdown files must match a heading (or HTML anchor).
 * The query string is ignored. Never throws.
 */
export const checkLocalLink = (
  file: string,
  href: string,
  context: LocalCheckContext,
): LinkCheckResult => {
  const { root } = context;
  const { path, hash } = parseLocalHref(href);
  const target = resolveLocalTarget(file, path, root);
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

  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(target);
  } catch {
    return { ok: false, error: "broken link", errorDetail: `File not found: ${displayTarget}` };
  }
  // Symlinks inside the repository must not point outside of it either
  if (!isRealPathInsideRoot(root, target)) {
    return outside;
  }

  if (!hash || hash === "/") {
    return { ok: true, status: 200 };
  }
  if (hash.includes(":~:")) {
    return { ok: true, status: 200, note: "Text Fragment" };
  }
  if (stats.isDirectory()) {
    return checkDirectoryAnchor(target, hash, context, outside);
  }
  return isMarkdownFile(target)
    ? checkMarkdownAnchor(target, hash, context)
    : checkLineAnchor(target, hash, displayTarget);
};

export type CollectedLinks = {
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
 * @throws {Error} if no markdown file matches the patterns (probably a typo, checking nothing would pass silently)
 */
export const collectLinksFromFiles = async ({
  patterns,
  cwd,
  sampleRate,
}: {
  patterns: string[];
  cwd: string;
  sampleRate?: number;
}): Promise<CollectedLinks> => {
  const allFiles = await findMarkdownFiles(patterns, cwd);
  if (allFiles.length === 0) {
    throw new Error(`No markdown files match ${patterns.map((p) => `"${p}"`).join(", ")}.`);
  }
  const files = sampleItems({
    items: allFiles,
    key: (file) => file,
    rate: sampleRate,
    label: "files",
  });
  const collected: CollectedLinks = { files, local: [], external: [], skipped: [] };
  for (const file of files) {
    const markdown = readFileSync(resolve(cwd, file), "utf8");
    for (const { href, text, line } of extractMarkdownLinks(markdown)) {
      const kind = getLinkKind(href);
      collected[LINK_GROUPS[kind]].push({
        page: file,
        // Protocol-relative links (`//example.com`) are checked over https
        href: kind === "external" && href.startsWith("//") ? `https:${href}` : href,
        text,
        ...(line ? { line } : {}),
      });
    }
  }
  return collected;
};

type CheckLocalFilesArgs = {
  /** Glob patterns or file paths, relative to `cwd` */
  patterns: string[];
  /** Directory the patterns and root-relative links (`/docs/a.md`) are resolved against, default `process.cwd()` */
  cwd?: string;
  /** Defaults to `LINK_CHECK_SAMPLE_RATE` */
  sampleRate?: number;
  baseline?: Baseline;
  /** Where to save the JSON and HTML reports, `false` to not save them. Default `results` */
  outputDir?: string | false;
  /**
   * Base URL of `cwd` (ending with `/`, e.g. `https://github.com/owner/repo/blob/<sha>/`): the HTML report links
   * files and relative links to it. Without it, they are rendered as plain text.
   */
  sourceBaseUrl?: string;
};

/**
 * Checks links in local markdown files: relative links and anchors on the filesystem,
 * absolute links with the usual `checkLinks` pipeline (fetch, GitHub API, Playwright).
 */
export const checkLocalFiles = ({
  patterns,
  cwd = process.cwd(),
  sampleRate,
  baseline = EMPTY_BASELINE,
  outputDir = "results",
  sourceBaseUrl,
}: CheckLocalFilesArgs) =>
  withRun(async () => {
    const root = isAbsolute(cwd) ? cwd : resolve(cwd);
    const collected = await timePhase("Extract links", () =>
      collectLinksFromFiles({ patterns, cwd: root, sampleRate }),
    );
    console.log(
      `Found ${collected.local.length + collected.external.length} links in ${collected.files.length} files ` +
        `(${collected.local.length} local, ${collected.external.length} external, ${collected.skipped.length} skipped).`,
    );

    const anchorCache = new Map<string, Set<string>>();
    const localResults: LinkWithResult[] = collected.local.map((link) => ({
      ...link,
      result: checkLocalLink(resolve(root, link.page), link.href, { root, anchorCache }),
    }));

    const externalLinks = filterOutIrrelevantLinks(collected.external);
    const { results, errors } =
      externalLinks.length > 0
        ? await checkLinks({ links: externalLinks })
        : { results: [], errors: [] };

    const report = getJSONReport({
      links: [...localResults, ...results],
      errors,
      siteName: LOCAL_FILES_SITE_NAME,
      baseline,
    });
    if (outputDir !== false) {
      saveReport(report, outputDir, { sourceBaseUrl });
    }
    console.log(report.summary);
    return report;
  });
