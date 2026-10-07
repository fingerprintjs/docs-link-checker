import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { glob } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type Baseline, EMPTY_BASELINE } from "./baseline";
import { safeDecode } from "./github/gh_url";
import { decodeHash } from "./hash";
import { checkLineAnchor, countLines, parseLineAnchor } from "./line_anchor";
import { checkLinks } from "./link";
import { extractMarkdownLinks, getMarkdownAnchors, hasMatchingAnchor } from "./markdown";
import { filterOutIrrelevantLinks } from "./page";
import { getJSONReport, saveReport } from "./report/report";
import { type RunConfig, timePhase, withRun } from "./run";
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

export type LinkKind = "local" | "external" | "skip";

/**
 * - `external`: `http(s)://` and protocol-relative (`//host/path`) links, checked over the network.
 * - `skip`: other schemes (`mailto:`, `tel:`, `data:`...) and empty links.
 * - `local`: everything else (relative paths, root-relative paths, `#anchors`), checked on the filesystem.
 */
export const getLinkKind = (href: string): LinkKind => {
  if (href.trim() === "") return "skip";
  if (/^https?:\/\//i.test(href) || href.startsWith("//")) return "external";
  if (/^[a-z][a-z\d+.-]*:/i.test(href)) return "skip";
  return "local";
};

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

/** `#anchor` in a markdown file must match a heading (or HTML anchor), with or without GitHub's prefix */
const checkMarkdownAnchor = (
  markdownFile: string,
  hash: string,
  { root, anchorCache }: LocalCheckContext,
): LinkCheckResult => {
  const anchor = decodeHash(hash).toLowerCase();
  const anchors = getAnchorsOfFile(markdownFile, anchorCache);
  if (hasMatchingAnchor(anchors, anchor)) {
    return { ok: true, status: 200 };
  }
  return {
    ok: false,
    error: "hash not found",
    status: 200,
    errorDetail: `No heading matching #${hash} in ${toPosixPath(relative(root, markdownFile))}`,
  };
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
    // GitHub renders the README of a directory, anchors point to its headings
    const readme = findReadme(target);
    if (!readme) {
      return { ok: true, status: 200, note: "Hash not checked (directory without README)" };
    }
    return isRealPathInsideRoot(root, readme)
      ? checkMarkdownAnchor(readme, hash, context)
      : outside;
  }
  if (isMarkdownFile(target)) {
    return checkMarkdownAnchor(target, hash, context);
  }
  // GitHub line links (`#L10`, `#L10-L20`) on code files: the file must have enough lines
  const lineResult = parseLineAnchor(hash)
    ? checkLineAnchor(hash, countLines(readFileSync(target, "utf8")), displayTarget)
    : undefined;
  return lineResult ?? { ok: true, status: 200, note: "Hash not checked (not a markdown file)" };
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
};

type CheckLocalFilesArgs = RunConfig & {
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
  hostConcurrency,
}: CheckLocalFilesArgs) =>
  withRun({ hostConcurrency }, async () => {
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
    const results = externalLinks.length > 0 ? await checkLinks({ links: externalLinks }) : [];

    const report = getJSONReport({
      links: [...localResults, ...results],
      siteName: LOCAL_FILES_SITE_NAME,
      baseline,
    });
    if (outputDir !== false) {
      saveReport(report, outputDir, { sourceBaseUrl });
    }
    console.log(report.summary);
    return report;
  });
