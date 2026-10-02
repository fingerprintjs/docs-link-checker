import * as cheerio from "cheerio";
import GithubSlugger from "github-slugger";
import { marked, Parser, type Token } from "marked";
import { decodeHash } from "../../hash";
import { checkLineAnchor, countLines } from "../../line_anchor";
import type { LinkCheckResult } from "../../types";
import { tryCatch } from "../../utils/tryCatch";
import { getApiErrorResult } from "../gh_api_error";
import { getBlobCached } from "../gh_cache";
import { getRefPathContent } from "../gh_ref";
import { isGithubCodeLineLink } from "../gh_url";

// GitHub prefixes ids in rendered markdown with `user-content-`, links work both with and without it
const USER_CONTENT_PREFIX = "user-content-";

/**
 * Collects anchor ids from HTML: `id` on any element and `name` on `<a>` elements.
 */
const getHtmlAnchors = (html: string): string[] => {
  const $ = cheerio.load(html, null, false);
  const anchors: string[] = [];
  $("[id]").each((_, element) => {
    const id = $(element).attr("id");
    if (id) anchors.push(id);
  });
  $("a[name]").each((_, element) => {
    const name = $(element).attr("name");
    if (name) anchors.push(name);
  });
  return anchors;
};

/**
 * Returns all anchors GitHub generates for a markdown file (lowercase):
 * - Heading slugs (GitHub-slugger semantics, duplicate headings get `-1`, `-2`... suffixes).
 *   Headings in fenced code blocks are ignored, headings in blockquotes and lists are included.
 * - Explicit HTML anchors like `<a name="x">`, `<a id="x">` and `<h2 id="x">`.
 */
export const getMarkdownAnchors = (markdown: string): Set<string> => {
  const slugger = new GithubSlugger();
  const anchors = new Set<string>();

  marked.walkTokens(marked.lexer(markdown), (token: Token) => {
    if (token.type === "heading") {
      // Slug is based on the rendered text content of the heading (no markdown syntax, link URLs or HTML tags)
      const headingHtml = Parser.parseInline(token.tokens ?? []);
      const headingText = cheerio.load(headingHtml, null, false).text().trim();
      anchors.add(slugger.slug(headingText));
    }
    if (token.type === "html") {
      for (const anchor of getHtmlAnchors(token.raw)) {
        anchors.add(anchor.toLowerCase());
      }
    }
  });

  return anchors;
};

// Decoded text per file response: the response is cached for the run, so each file is decoded once for all its hashes
const textByFile = new WeakMap<object, Promise<FileText>>();
// Anchors per file text
const anchorsByText = new WeakMap<FileText, Set<string>>();

/** Text of a file, `binary` if it contains a NUL byte (GitHub shows no lines for binary files) */
type FileText = { text: string; binary: boolean };

/** A file from the contents API (not a directory, symlink or submodule) */
type FileData = { content: string; encoding?: string; sha: string; size?: number };

/**
 * Text of a file. Files over 1 MB have no content in the contents API (`encoding: "none"`), they are read with the
 * blob API (up to 100 MB).
 */
const getFileText = (owner: string, repo: string, file: FileData): Promise<FileText> => {
  let text = textByFile.get(file);
  if (!text) {
    text = (async () => {
      const isLarge = file.encoding === "none" || (file.content === "" && (file.size ?? 0) > 0);
      const base64 = isLarge
        ? (await getBlobCached(owner, repo, file.sha)).data.content
        : file.content;
      const buffer = Buffer.from(base64, "base64");
      return { text: buffer.toString("utf8"), binary: buffer.includes(0) };
    })();
    textByFile.set(file, text);
    // A failed request is not kept, the next hash asks again (the API responses are cached for the run anyway)
    text.catch(() => textByFile.delete(file));
  }
  return text;
};

const getTextAnchors = (fileText: FileText): Set<string> => {
  let anchors = anchorsByText.get(fileText);
  if (!anchors) {
    anchors = getMarkdownAnchors(fileText.text);
    anchorsByText.set(fileText, anchors);
  }
  return anchors;
};

/** GitHub renders these files, their anchors are headings (see `getMarkdownAnchors`) */
const isRenderedMarkdown = (path: string, url: URL) =>
  /\.(md|markdown|mdown|mkdn|mkd|mdwn)$/i.test(path) && url.searchParams.get("plain") !== "1";

/** `true` if the heading anchors of the file include the hash (lowercase, with or without `user-content-`) */
const hasHeadingAnchor = (fileText: FileText, hash: string) => {
  const anchors = getTextAnchors(fileText);
  const hashWithoutPrefix = hash.startsWith(USER_CONTENT_PREFIX)
    ? hash.slice(USER_CONTENT_PREFIX.length)
    : hash;
  return anchors.has(hash) || anchors.has(hashWithoutPrefix);
};

/**
 * Check if a GitHub blob exists, and its hash: a heading of a markdown file, or a code line (`#L12`, `#L12-L15`,
 * `#L12C3-L15C1`, the file must have enough lines, see `checkLineAnchor`). Code lines are checked with the API, not in the browser:
 * github.com refuses blob pages to headless browsers on CI runners (503).
 * @param fullUrl - The full URL of the blob
 * @param owner - The owner of the repository
 * @param repo - The repository name
 * @param pathParts - The path parts of the URL
 * @returns - A LinkCheckResult object
 */
export const checkGitHubBlobLink = async (
  fullUrl: URL,
  owner: string,
  repo: string,
  pathParts: string[],
): Promise<LinkCheckResult> => {
  // Remove the # character, decode percent-encoding and make it lowercase
  const hash = decodeHash(fullUrl.hash).toLowerCase();

  const content = await getRefPathContent(owner, repo, pathParts.slice(1), { requirePath: true });
  if (!content.found) {
    return getApiErrorResult(content.error, "File not found in repository");
  }

  // If there's no hash, we're done - the file exists
  if (!hash) {
    return { ok: true, status: 200 };
  }

  // For hash checking, we need to get the file content
  const fileData = content.response?.data;
  if (!fileData || !("content" in fileData)) {
    return {
      ok: false,
      error: "hash not found",
      status: 200,
      errorDetail: "File has no content",
    };
  }

  const { data: fileText, error } = await tryCatch(getFileText(owner, repo, fileData));
  if (error) {
    return getApiErrorResult(error, "File content not found in repository");
  }

  // `#L12`, `#L12-L15`, `#L12C3-L15C1` (case-sensitive, `#l12` is not a line anchor), see `parseLineAnchor`
  const lineResult = isGithubCodeLineLink(fullUrl.href)
    ? checkLineAnchor(
        decodeHash(fullUrl.hash),
        fileText.binary ? 0 : countLines(fileText.text),
        fileText.binary ? `${content.path} (binary file)` : content.path,
      )
    : undefined;
  if (lineResult) {
    // Rendered markdown (without `?plain=1`): a heading like `## L12` matches too
    return !lineResult.ok &&
      isRenderedMarkdown(content.path, fullUrl) &&
      hasHeadingAnchor(fileText, hash)
      ? { ok: true, status: 200 }
      : lineResult;
  }

  if (hasHeadingAnchor(fileText, hash)) {
    return { ok: true, status: 200 };
  }

  return {
    ok: false,
    error: "hash not found",
    status: 200,
    errorDetail: `No heading found matching hash: ${hash}`,
  };
};
