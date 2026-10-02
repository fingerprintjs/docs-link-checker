/**
 * Glob matching for baseline patterns without regular expressions (patterns come from user files, a regular
 * expression built from them could backtrack catastrophically).
 *
 * - `**` (or any longer run of `*`) matches any characters, including `/`.
 * - `*` matches any characters except `/`.
 * - Every other character is literal, including `?`, `[`, `(`, `+`, `.` and `\` (URLs are full of them).
 *
 * Matching runs in `O(pattern tokens × text length)` steps (plus the literal comparisons), whatever the input.
 */

type GlobToken = { type: "literal"; value: string } | { type: "star" } | { type: "globstar" };

/** Longest accepted pattern, longer values are rejected when the baseline is validated */
export const MAX_GLOB_LENGTH = 2048;

export const parseGlob = (glob: string): GlobToken[] => {
  const tokens: GlobToken[] = [];
  let literal = "";
  let i = 0;
  while (i < glob.length) {
    if (glob[i] !== "*") {
      literal += glob[i];
      i++;
      continue;
    }
    let end = i;
    while (end < glob.length && glob[end] === "*") end++;
    if (literal) {
      tokens.push({ type: "literal", value: literal });
      literal = "";
    }
    tokens.push({ type: end - i >= 2 ? "globstar" : "star" });
    i = end;
  }
  if (literal) {
    tokens.push({ type: "literal", value: literal });
  }
  return tokens;
};

/** Positions after `literal` that start at a reachable position */
const advanceLiteral = (reachable: Uint8Array, text: string, literal: string): Uint8Array => {
  const next = new Uint8Array(reachable.length);
  for (let i = 0; i + literal.length <= text.length; i++) {
    if (reachable[i] && text.startsWith(literal, i)) {
      next[i + literal.length] = 1;
    }
  }
  return next;
};

/** A wildcard extends every reachable position to the right, `*` (not `**`) stops at `/` */
const advanceWildcard = (reachable: Uint8Array, text: string, stopAtSlash: boolean): Uint8Array => {
  const next = new Uint8Array(reachable.length);
  let active = false;
  for (let i = 0; i <= text.length; i++) {
    active ||= reachable[i] === 1;
    if (active) {
      next[i] = 1;
    }
    if (stopAtSlash && text[i] === "/") {
      active = false;
    }
  }
  return next;
};

/**
 * Checks if `text` matches the parsed glob. Tracks the set of text positions the pattern prefix can end at
 * (no backtracking).
 */
const matchGlobTokens = (tokens: GlobToken[], text: string): boolean => {
  let reachable: Uint8Array = new Uint8Array(text.length + 1);
  reachable[0] = 1;
  for (const token of tokens) {
    reachable =
      token.type === "literal"
        ? advanceLiteral(reachable, text, token.value)
        : advanceWildcard(reachable, text, token.type === "star");
    if (!reachable.includes(1)) {
      return false;
    }
  }
  return reachable[text.length] === 1;
};

/** Returns a matcher for the glob (parsed once) */
export const createGlobMatcher = (glob: string): ((text: string) => boolean) => {
  const tokens = parseGlob(glob);
  return (text) => matchGlobTokens(tokens, text);
};

export const matchGlob = (glob: string, text: string): boolean => createGlobMatcher(glob)(text);
