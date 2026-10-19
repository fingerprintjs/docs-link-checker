import type { MarkdownLink } from "./markdown";

/**
 * Finds absolute links in source code (JSX/TSX, JS, Vue...), for example docs links in `href` attributes or strings.
 * Plain text search, no parser: the same for every language, also finds URLs in comments.
 * Relative links are not extracted, in source code they are app routes and not files on disk.
 */

// Ends at whitespace, quotes, backticks, `<>`, brackets and backslashes (JS escapes),
// so a URL inside `'...'`, `"..."`, `(...)` or `<a href=...>` doesn't take the delimiter with it
const URL_PATTERN = /https?:\/\/[^\s"'`<>()[\]\\]+/gi;

// Sentence punctuation after a URL in comments and strings (`see https://example.com.`)
const TRAILING_PUNCTUATION = /[.,;:!?*]+$/;

/** Extracts absolute `http(s)://` URLs with their line. Templates (`${id}`, `{id}`) are not real links, they are skipped. */
export const extractSourceCodeLinks = (code: string): MarkdownLink[] => {
  const links: MarkdownLink[] = [];
  for (const [index, lineText] of code.split("\n").entries()) {
    for (const [match] of lineText.matchAll(URL_PATTERN)) {
      const href = match.replace(TRAILING_PUNCTUATION, "");
      if (/[{}]/.test(href) || /^https?:\/\/$/i.test(href)) continue;
      links.push({ href, text: "", line: index + 1 });
    }
  }
  return links;
};
