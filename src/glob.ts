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

/**
 * Checks if `text` matches the parsed glob. Tracks the set of text positions the pattern prefix can end at
 * (no backtracking).
 */
export const matchGlobTokens = (tokens: GlobToken[], text: string): boolean => {
  const length = text.length;
  let reachable = new Uint8Array(length + 1);
  reachable[0] = 1;
  for (const token of tokens) {
    const next = new Uint8Array(length + 1);
    let any = false;
    if (token.type === "literal") {
      for (let i = 0; i + token.value.length <= length; i++) {
        if (reachable[i] && text.startsWith(token.value, i)) {
          next[i + token.value.length] = 1;
          any = true;
        }
      }
    } else {
      // A wildcard extends every reachable position to the right, `*` stops at `/`
      let active = false;
      for (let i = 0; i <= length; i++) {
        if (reachable[i]) active = true;
        if (active) {
          next[i] = 1;
          any = true;
        }
        if (token.type === "star" && text[i] === "/") active = false;
      }
    }
    if (!any) {
      return false;
    }
    reachable = next;
  }
  return reachable[length] === 1;
};

/** Returns a matcher for the glob (parsed once) */
export const createGlobMatcher = (glob: string): ((text: string) => boolean) => {
  const tokens = parseGlob(glob);
  return (text) => matchGlobTokens(tokens, text);
};

export const matchGlob = (glob: string, text: string): boolean => createGlobMatcher(glob)(text);
