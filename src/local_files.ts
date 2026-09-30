import { readdirSync, readFileSync, statSync } from "node:fs";
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
import { sampleItems } from "./utils";

export const LOCAL_FILES_SITE_NAME = "local files";

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const IGNORED_DIRECTORIES = new Set(["node_modules", ".git"]);

const isMarkdownFile = (path: string) => MARKDOWN_EXTENSIONS.has(extname(path).toLowerCase());

/** Relative path with `/` separators (used as the page of local links, in reports and annotations) */
export const toPosixPath = (path: string) => path.split(sep).join("/");

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
  return [...files].sort();
};

export type MarkdownLink = { href: string; text: string; line?: number };

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
    if (lineStarts[middle] <= offset) {
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
    const candidates = [raw, raw.split("\n")[0]];
    for (const candidate of candidates) {
      const offset = source.indexOf(candidate, cursor);
      if (offset !== -1) {
        cursor = offset + candidate.length;
        return lineAt(lineStarts, offset);
      }
    }
    return undefined;
  };

  marked.walkTokens(marked.lexer(source), (token: Token) => {
    if (token.type === "link") {
      const link = token as Tokens.Link;
      links.push({ href: link.href, text: stripFormatting(link.text), line: findLine(link.raw) });
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

// Supported README names (compared case-insensitively), in order of preference
const README_NAMES = ["readme.md", "readme.markdown"];

/**
 * The README GitHub renders for a directory: `README.md` or `README.markdown` in any case (`readme.md`,
 * `Readme.markdown`...). Deterministic when there are several: `.md` first, then by name in code point order
 * (`README.md` before `Readme.md` before `readme.md`). Directories with such names are ignored.
 */
export const findReadme = (directory: string): string | undefined => {
  const candidates = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && README_NAMES.includes(entry.name.toLowerCase()))
    .map((entry) => entry.name)
    .sort((a, b) => {
      const byExtension =
        README_NAMES.indexOf(a.toLowerCase()) - README_NAMES.indexOf(b.toLowerCase());
      return byExtension !== 0 ? byExtension : a < b ? -1 : a > b ? 1 : 0;
    });
  return candidates.length > 0 ? join(directory, candidates[0]) : undefined;
};

/**
 * Checks a local link (relative path, root-relative path or `#anchor`) found in `file`:
 * the target file or directory must exist, `#anchors` in markdown files must match a heading (or HTML anchor).
 * The query string is ignored. Never throws.
 */
export const checkLocalLink = (
  file: string,
  href: string,
  { root, anchorCache }: LocalCheckContext,
): LinkCheckResult => {
  const hashIndex = href.indexOf("#");
  const pathAndQuery = hashIndex === -1 ? href : href.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : href.slice(hashIndex + 1);
  const path = decodePath(pathAndQuery.split("?")[0]);

  const target =
    path === "" ? file : path.startsWith("/") ? join(root, path) : resolve(dirname(file), path);
  const displayTarget = toPosixPath(relative(root, target)) || ".";

  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(target);
  } catch {
    return { ok: false, error: "broken link", errorDetail: `File not found: ${displayTarget}` };
  }

  if (!hash || hash === "/") {
    return { ok: true, status: 200 };
  }
  if (hash.includes(":~:")) {
    return { ok: true, status: 200, note: "Text Fragment" };
  }

  let markdownFile: string | undefined;
  if (stats.isDirectory()) {
    // GitHub renders the README of a directory, anchors point to its headings
    markdownFile = findReadme(target);
    if (!markdownFile) {
      return { ok: true, status: 200, note: "Hash not checked (directory without README)" };
    }
  } else if (isMarkdownFile(target)) {
    markdownFile = target;
  }

  if (!markdownFile) {
    // GitHub line links (`#L10`, `#L10-L20`) on code files: the file must have enough lines
    const lineMatch = GITHUB_LINE_HASH.exec(hash);
    if (lineMatch) {
      const lastLine = Math.max(Number(lineMatch[1]), Number(lineMatch[2] ?? 0));
      const lineCount = readFileSync(target, "utf8").replace(/\n$/, "").split("\n").length;
      return lastLine <= lineCount
        ? { ok: true, status: 200 }
        : {
            ok: false,
            error: "hash not found",
            status: 200,
            errorDetail: `${displayTarget} has only ${lineCount} lines`,
          };
    }
    return { ok: true, status: 200, note: "Hash not checked (not a markdown file)" };
  }

  const anchor = decodeHash(hash).toLowerCase();
  const anchors = getAnchorsOfFile(markdownFile, anchorCache);
  const withoutPrefix = anchor.startsWith(USER_CONTENT_PREFIX)
    ? anchor.slice(USER_CONTENT_PREFIX.length)
    : anchor;
  if (anchors.has(anchor) || anchors.has(withoutPrefix)) {
    return { ok: true, status: 200 };
  }
  return {
    ok: false,
    error: "hash not found",
    status: 200,
    errorDetail: `No heading matching #${hash} in ${toPosixPath(relative(root, markdownFile))}`,
  };
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
      saveReport(report, outputDir);
    }
    console.log(report.summary);
    return report;
  });
