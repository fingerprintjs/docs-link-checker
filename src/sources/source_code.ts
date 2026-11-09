import type { MarkdownLink } from "../check/markdown";

/**
 * Finds absolute links in source code (JSX/TSX, JS, Vue...), for example docs links in `href` attributes or strings.
 * Plain text search, no parser: the same for every language, also finds URLs in comments.
 * Relative links are not extracted, in source code they are app routes and not files on disk.
 */

// Ends at whitespace, quotes, backticks, `<>` and backslashes (JS escapes),
// so a URL inside `'...'`, `"..."` or `<a href=...>` doesn't take the delimiter with it
const URL_PATTERN = /https?:\/\/[^\s"'`<>\\]+/gi;
const QUOTES = new Set(['"', "'", "`"]);
// Sentence punctuation after a URL in comments (`see https://example.com.`)
const TRAILING_PUNCTUATION = ".,;:!?*";
const OPENING_BRACKETS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

const count = (text: string, char: string) => text.split(char).length - 1;

/**
 * Trims what follows a URL in prose, like GitHub's autolinks: trailing punctuation, the end of a block comment
 * and closing brackets without an opening one (`(see https://example.com/a)`, `{@link https://example.com/a}`,
 * but `https://en.wikipedia.org/wiki/A_(b)`)
 */
const trimProse = (url: string): string => {
  let trimmed = url;
  for (;;) {
    const last = trimmed.at(-1) ?? "";
    const opening = OPENING_BRACKETS[last];
    const isUnbalanced = opening !== undefined && count(trimmed, opening) < count(trimmed, last);
    if (trimmed.endsWith("*/")) {
      trimmed = trimmed.slice(0, -2);
    } else if (TRAILING_PUNCTUATION.includes(last) || isUnbalanced) {
      trimmed = trimmed.slice(0, -1);
    } else {
      return trimmed;
    }
  }
};

/**
 * Extracts absolute `http(s)://` URLs with their line.
 * - A URL that ends at a quote is exact, otherwise it is trimmed like prose.
 * - `&amp;` is decoded, in HTML and JSX attributes it is `&`.
 * - Templates (`${id}`, `{id}`) are not real links, they are skipped.
 */
export const extractSourceCodeLinks = (code: string): MarkdownLink[] => {
  const links: MarkdownLink[] = [];
  for (const [index, lineText] of code.split("\n").entries()) {
    for (const { 0: match, index: start } of lineText.matchAll(URL_PATTERN)) {
      const isQuoted = QUOTES.has(lineText[start + match.length] ?? "");
      const href = (isQuoted ? match : trimProse(match)).replaceAll("&amp;", "&");
      if (/[{}]/.test(href) || /^https?:\/\/$/i.test(href)) continue;
      links.push({ href, text: "", line: index + 1 });
    }
  }
  return links;
};
