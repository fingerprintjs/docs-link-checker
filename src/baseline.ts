import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createGlobMatcher, MAX_GLOB_LENGTH } from "./glob";
import type { LinkWithResult } from "./types";

/**
 * A baseline (ignore) file lists known false positives and accepted broken links.
 * Failing links that match an entry are reported as "ignored" and don't count towards `totalLinksToFix`.
 *
 * ```json
 * {
 *   "ignore": [
 *     { "href": "https://example.com/flaky", "page": "docs/guide.md", "reason": "Blocks bots" },
 *     { "pattern": "https://twitter.com/**", "reason": "Always asks for a login" },
 *     "https://www.linkedin.com/**"
 *   ]
 * }
 * ```
 *
 * - `href`: exact link URL (as reported, e.g. the resolved URL on websites, the link as written in local files).
 * - `pattern`: a glob (`**` matches anything, `*` anything except `/`, everything else is literal, including `?`),
 *   see `src/glob.ts`. A plain string entry is a shorthand for `{ "pattern": ... }`.
 * Every entry has exactly one of `href` or `pattern`. Regular expressions are not supported on purpose: patterns come
 * from files, and a regular expression like `(a+)+$` could make the check hang (ReDoS). Globs never use `RegExp`.
 * - `page` (optional): only ignore the link on this page (same glob syntax, a value without `*` is an exact match).
 * - `reason` (optional): shown in the report.
 */
export type BaselineEntry = {
  href?: string;
  pattern?: string;
  page?: string;
  reason?: string;
};

export type BaselineFile = {
  ignore: BaselineEntry[];
};

export const DEFAULT_BASELINE_FILE = "linkcheck.baseline.json";

type Matcher = (value: string) => boolean;

export type Baseline = {
  entries: BaselineEntry[];
  /** The first entry matching the (failing) link, if any */
  findEntry: (link: { href: string; page: string }) => BaselineEntry | undefined;
};

export class BaselineError extends Error {
  override name = "BaselineError";
}

const ALLOWED_KEYS = new Set(["href", "pattern", "page", "reason"]);
const URL_KEYS = ["href", "pattern"] as const;

/**
 * Validates the parsed JSON of a baseline file. Accepts `{ "ignore": [...] }` or a bare array of entries.
 * @throws {BaselineError} with a message pointing to the invalid entry
 */
export const validateBaseline = (data: unknown): BaselineFile => {
  let list: unknown;
  if (Array.isArray(data)) {
    list = data;
  } else if (data && typeof data === "object") {
    const unknownKeys = Object.keys(data).filter((key) => key !== "ignore" && key !== "$schema");
    if (unknownKeys.length > 0) {
      throw new BaselineError(`unknown top-level key(s): ${unknownKeys.join(", ")}`);
    }
    list = (data as { ignore?: unknown }).ignore;
    if (list === undefined) {
      throw new BaselineError(`expected an "ignore" array`);
    }
  } else {
    throw new BaselineError(`expected an object with an "ignore" array, or an array`);
  }
  if (!Array.isArray(list)) {
    throw new BaselineError(`"ignore" must be an array`);
  }

  const entries = list.map((item, index): BaselineEntry => {
    const where = `ignore[${index}]`;
    if (typeof item === "string") {
      if (item === "") {
        throw new BaselineError(`${where}: pattern must not be empty`);
      }
      if (item.length > MAX_GLOB_LENGTH) {
        throw new BaselineError(`${where}: pattern is longer than ${MAX_GLOB_LENGTH} characters`);
      }
      return { pattern: item };
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new BaselineError(`${where}: expected a string pattern or an object`);
    }
    for (const key of Object.keys(item)) {
      if (key === "regex") {
        throw new BaselineError(
          `${where}: "regex" is not supported (regular expressions could make the check hang), use a "pattern" glob with * and ** instead`,
        );
      }
      if (!ALLOWED_KEYS.has(key)) {
        throw new BaselineError(
          `${where}: unknown key "${key}" (allowed: ${[...ALLOWED_KEYS].join(", ")})`,
        );
      }
    }
    const entry = item as Record<string, unknown>;
    for (const key of ALLOWED_KEYS) {
      if (entry[key] !== undefined && (typeof entry[key] !== "string" || entry[key] === "")) {
        throw new BaselineError(`${where}: "${key}" must be a non-empty string`);
      }
    }
    if (URL_KEYS.filter((key) => entry[key] !== undefined).length !== 1) {
      throw new BaselineError(`${where}: expected exactly one of "href" or "pattern"`);
    }
    for (const key of ["pattern", "page"] as const) {
      const value = entry[key];
      if (typeof value === "string" && value.length > MAX_GLOB_LENGTH) {
        throw new BaselineError(`${where}: "${key}" is longer than ${MAX_GLOB_LENGTH} characters`);
      }
    }
    return item as BaselineEntry;
  });
  return { ignore: entries };
};

/** Builds a matcher for validated baseline entries */
export const createBaseline = (entries: BaselineEntry[]): Baseline => {
  const compiled = entries.map((entry) => {
    // Plain string comparisons and the regex-free glob matcher only, never `RegExp` from user input
    const hrefMatches: Matcher =
      entry.href !== undefined
        ? (href) => href === entry.href
        : createGlobMatcher(entry.pattern ?? "");
    const pageMatches: Matcher | undefined =
      entry.page !== undefined ? createGlobMatcher(entry.page) : undefined;
    return { entry, hrefMatches, pageMatches };
  });
  return {
    entries,
    findEntry: (link) =>
      compiled.find(
        ({ hrefMatches, pageMatches }) =>
          hrefMatches(link.href) && (!pageMatches || pageMatches(link.page)),
      )?.entry,
  };
};

export const EMPTY_BASELINE = createBaseline([]);

/**
 * Reads and validates a baseline file.
 * @param allowMissing return an empty baseline if the file does not exist (used with `--update-baseline`)
 * @throws {BaselineError} if the file is missing, not valid JSON, or not a valid baseline
 */
export const loadBaseline = (path: string, { allowMissing = false } = {}): Baseline => {
  if (!existsSync(path)) {
    if (allowMissing) {
      return EMPTY_BASELINE;
    }
    throw new BaselineError(`Baseline file not found: ${path}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new BaselineError(`Invalid baseline file ${path}: ${(error as Error).message}`);
  }
  try {
    return createBaseline(validateBaseline(data).ignore);
  } catch (error) {
    throw new BaselineError(`Invalid baseline file ${path}: ${(error as Error).message}`);
  }
};

type UpdateBaselineArgs = {
  baseline: Baseline;
  /** All failing links of the run that should be in the baseline (links to fix and ignored links) */
  failures: Pick<LinkWithResult, "href" | "page" | "result">[];
  /**
   * Keep existing `href` entries that matched no failure. Use it when not every page was checked
   * (sampling), otherwise entries of fixed links are dropped.
   */
  keepUnmatched?: boolean;
  reason?: string;
};

/**
 * Computes the new baseline after a run:
 * - `pattern` entries are always kept (they are hand-written).
 * - Existing `href` entries are kept if they still match a failure (or with `keepUnmatched`), with their reason.
 * - Failures not matched by any entry are added as `{ href, page, reason }`.
 */
export const updateBaseline = ({
  baseline,
  failures,
  keepUnmatched = false,
  reason,
}: UpdateBaselineArgs): BaselineFile => {
  const matched = new Set<BaselineEntry>();
  const added = new Map<string, BaselineEntry>();
  for (const failure of failures) {
    const entry = baseline.findEntry(failure);
    if (entry) {
      matched.add(entry);
      continue;
    }
    const key = JSON.stringify([failure.page, failure.href]);
    if (!added.has(key)) {
      added.set(key, {
        href: failure.href,
        page: failure.page,
        ...(reason ? { reason } : {}),
      });
    }
  }
  const kept = baseline.entries.filter(
    (entry) => entry.href === undefined || keepUnmatched || matched.has(entry),
  );
  const newEntries = [...added.values()].sort(
    (a, b) =>
      (a.page ?? "").localeCompare(b.page ?? "") || (a.href ?? "").localeCompare(b.href ?? ""),
  );
  return { ignore: [...kept, ...newEntries] };
};

export const writeBaseline = (path: string, file: BaselineFile) => {
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
};
