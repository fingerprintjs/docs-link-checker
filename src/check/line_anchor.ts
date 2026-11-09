import { safeDecode } from "../github/url";
import type { LinkCheckResult } from "../types";

/**
 * GitHub line anchors (without `#`): `L10`, `L10-L20`, with optional columns (`L10C5-L12C3`)
 */
const GITHUB_LINE_HASH = /^L(\d+)(?:C\d+)?(?:-L(\d+)(?:C\d+)?)?$/;

/** First and last line of a GitHub line anchor (without `#`), `undefined` if it is not a line anchor */
export const parseLineAnchor = (
  hash: string,
): { firstLine: number; lastLine: number } | undefined => {
  const match = GITHUB_LINE_HASH.exec(hash);
  if (!match) {
    return undefined;
  }
  const firstLine = Number(match[1]);
  return { firstLine, lastLine: match[2] === undefined ? firstLine : Number(match[2]) };
};

/**
 * Check if a URL is a GitHub code line link like #L5, #L5-L10 or #L5C3-L10C1 (the grammar of `parseLineAnchor`)
 * @param href - The URL to check
 * @returns - True if the URL is a GitHub code line link, false otherwise
 */
export const isGithubCodeLineLink = (href: string) => {
  const url = new URL(href);
  return (
    url.host === "github.com" &&
    url.pathname.includes("/blob/") &&
    parseLineAnchor(safeDecode(url.hash).replace(/^#/, "")) !== undefined
  );
};

/**
 * Number of lines GitHub shows for a text file: a trailing newline does not start a new line (`"a\nb\n"` has 2 lines),
 * an empty file has none
 */
export const countLines = (text: string): number => {
  if (text === "") {
    return 0;
  }
  // One pass over the text without allocating per line (files can have millions of lines)
  let newlines = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    newlines++;
  }
  return text.endsWith("\n") ? newlines : newlines + 1;
};

/**
 * Checks a GitHub line anchor (without `#`, see `parseLineAnchor`) against the number of lines of a file.
 * Lines start at 1 and a range goes forward (`#L0`, `#L5-L0`, `#L9-L3` are not valid anchors), the last line of the
 * anchor must be in the file.
 * @param fileLabel the file in the error detail (`src/a.ts has only 3 lines`)
 * @returns `undefined` if the hash is not a line anchor
 */
export const checkLineAnchor = (
  hash: string,
  lineCount: number,
  fileLabel: string,
): LinkCheckResult | undefined => {
  const lines = parseLineAnchor(hash);
  if (!lines) {
    return undefined;
  }
  if (lines.firstLine < 1 || lines.lastLine < lines.firstLine) {
    return {
      ok: false,
      error: "hash not found",
      status: 200,
      errorDetail: `Invalid line anchor #${hash} (lines start at 1, ranges go forward)`,
    };
  }
  if (lines.lastLine > lineCount) {
    return {
      ok: false,
      error: "hash not found",
      status: 200,
      errorDetail: `${fileLabel} has only ${lineCount} line${lineCount === 1 ? "" : "s"}`,
    };
  }
  return { ok: true, status: 200 };
};
