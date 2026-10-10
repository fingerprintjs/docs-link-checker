import * as cheerio from "cheerio";
import GithubSlugger from "github-slugger";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { toString } from "mdast-util-to-string";
import { gfm } from "micromark-extension-gfm";
import { visit } from "unist-util-visit";

/**
 * Markdown parsing shared by local file checks and GitHub README checks: extracting links (with line numbers)
 * and the anchors GitHub renders for headings and explicit HTML anchors.
 * Uses mdast (https://github.com/syntax-tree/mdast) with GFM, the same dialect GitHub renders.
 */

export type MarkdownLink = { href: string; text: string; line?: number };

const parse = (markdown: string) =>
  fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });

// Rendered text, like GitHub shows it: no raw HTML tags, no image alt text
const textOf = (node: Parameters<typeof toString>[0]) =>
  toString(node, { includeHtml: false, includeImageAlt: false });

/**
 * Extracts links from markdown with the line they are on (links in code blocks are ignored).
 * Reference links (`[text][ref]`) are resolved with their definitions, undefined references are not links.
 */
export const extractMarkdownLinks = (markdown: string): MarkdownLink[] => {
  const tree = parse(markdown);
  const definitions = new Map<string, string>();
  visit(tree, "definition", (node) => {
    // The first definition wins, like in CommonMark
    if (!definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
  });

  const links: MarkdownLink[] = [];
  visit(tree, (node) => {
    if (node.type !== "link" && node.type !== "linkReference") return;
    const href = node.type === "link" ? node.url : definitions.get(node.identifier);
    if (href !== undefined) {
      links.push({ href, text: textOf(node), line: node.position?.start.line });
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

  visit(parse(markdown), (node) => {
    if (node.type === "heading") {
      anchors.add(slugger.slug(textOf(node).trim()));
    } else if (node.type === "html") {
      for (const anchor of getHtmlAnchors(node.value)) {
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
