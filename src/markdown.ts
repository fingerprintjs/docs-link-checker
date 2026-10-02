import * as cheerio from "cheerio";
import GithubSlugger from "github-slugger";
import { marked, Parser, type Token, type Tokens } from "marked";

/**
 * Markdown parsing shared by local file checks and GitHub README checks: extracting links (with line numbers)
 * and the anchors GitHub renders for headings and explicit HTML anchors.
 */

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
 * Extracts links from markdown with the line they are on (links in code blocks are ignored). Tokens have no
 * positions, so the line is found by searching the raw link text in the source, in document order. Links whose
 * raw text can't be found have no line.
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

  // The callback is synchronous, walkTokens returns its (empty) results
  void marked.walkTokens(marked.lexer(markdown), (token: Token) => {
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

// GitHub prefixes ids in rendered markdown with `user-content-`, links work both with and without it
const USER_CONTENT_PREFIX = "user-content-";

/** Does a (lowercase, decoded) hash match one of a file's anchors, with or without GitHub's `user-content-` prefix? */
export const hasMatchingAnchor = (anchors: Set<string>, hash: string): boolean => {
  const withoutPrefix = hash.startsWith(USER_CONTENT_PREFIX)
    ? hash.slice(USER_CONTENT_PREFIX.length)
    : hash;
  return anchors.has(hash) || anchors.has(withoutPrefix);
};
