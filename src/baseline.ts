import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createGlobMatcher, MAX_GLOB_LENGTH } from "./glob";
import type { LinkWithResult } from "./types";
import { getErrorMessage } from "./utils/errors";

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
  /** The first entry matching the (failing) link, if any (its reason is shown in the report) */
  findEntry: (link: { href: string; page: string }) => BaselineEntry | undefined;
  /** All entries matching the link, in file order */
  findEntries: (link: { href: string; page: string }) => BaselineEntry[];
};

export class BaselineError extends Error {
  override name = "BaselineError";
}

const ENTRY_KEYS = ["href", "pattern", "page", "reason"] as const;
const ALLOWED_KEYS = new Set<string>(ENTRY_KEYS);

/** The list of entries: `{ "ignore": [...] }` or a bare array */
const getIgnoreList = (data: unknown): readonly unknown[] => {
  if (Array.isArray(data)) {
    return data;
  }
  if (!data || typeof data !== "object") {
    throw new BaselineError(`expected an object with an "ignore" array, or an array`);
  }
  const unknownKeys = Object.keys(data).filter((key) => key !== "ignore" && key !== "$schema");
  if (unknownKeys.length > 0) {
    throw new BaselineError(`unknown top-level key(s): ${unknownKeys.join(", ")}`);
  }
  if (!("ignore" in data)) {
    throw new BaselineError(`expected an "ignore" array`);
  }
  if (!Array.isArray(data.ignore)) {
    throw new BaselineError(`"ignore" must be an array`);
  }
  return data.ignore;
};

/** A plain string entry, shorthand for `{ "pattern": ... }` */
const validatePatternShorthand = (pattern: string, where: string): BaselineEntry => {
  if (pattern === "") {
    throw new BaselineError(`${where}: pattern must not be empty`);
  }
  if (pattern.length > MAX_GLOB_LENGTH) {
    throw new BaselineError(`${where}: pattern is longer than ${MAX_GLOB_LENGTH} characters`);
  }
  return { pattern };
};

const validateEntryKeys = (keys: string[], where: string) => {
  for (const key of keys) {
    if (key === "regex") {
      throw new BaselineError(
        `${where}: "regex" is not supported (regular expressions could make the check hang), use a "pattern" glob with * and ** instead`,
      );
    }
    if (!ALLOWED_KEYS.has(key)) {
      throw new BaselineError(`${where}: unknown key "${key}" (allowed: ${ENTRY_KEYS.join(", ")})`);
    }
  }
};

const validateObjectEntry = (item: object, where: string): BaselineEntry => {
  const values: Record<string, unknown> = Object.fromEntries(Object.entries(item));
  validateEntryKeys(Object.keys(values), where);
  const entry: BaselineEntry = {};
  for (const key of ENTRY_KEYS) {
    const value = values[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "string" || value === "") {
      throw new BaselineError(`${where}: "${key}" must be a non-empty string`);
    }
    entry[key] = value;
  }
  if ((entry.href === undefined) === (entry.pattern === undefined)) {
    throw new BaselineError(`${where}: expected exactly one of "href" or "pattern"`);
  }
  for (const key of ["pattern", "page"] as const) {
    if ((entry[key]?.length ?? 0) > MAX_GLOB_LENGTH) {
      throw new BaselineError(`${where}: "${key}" is longer than ${MAX_GLOB_LENGTH} characters`);
    }
  }
  return entry;
};

/**
 * Validates the parsed JSON of a baseline file. Accepts `{ "ignore": [...] }` or a bare array of entries.
 * @throws {BaselineError} with a message pointing to the invalid entry
 */
export const validateBaseline = (data: unknown): BaselineFile => {
  const entries = getIgnoreList(data).map((item, index): BaselineEntry => {
    const where = `ignore[${index}]`;
    if (typeof item === "string") {
      return validatePatternShorthand(item, where);
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new BaselineError(`${where}: expected a string pattern or an object`);
    }
    return validateObjectEntry(item, where);
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
  const matches =
    (link: { href: string; page: string }) =>
    ({ hrefMatches, pageMatches }: (typeof compiled)[number]) =>
      hrefMatches(link.href) && (!pageMatches || pageMatches(link.page));
  return {
    entries,
    findEntry: (link) => compiled.find(matches(link))?.entry,
    findEntries: (link) => compiled.filter(matches(link)).map(({ entry }) => entry),
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
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    return createBaseline(validateBaseline(data).ignore);
  } catch (error) {
    throw new BaselineError(`Invalid baseline file ${path}: ${getErrorMessage(error)}`, {
      cause: error,
    });
  }
};

type UpdateBaselineArgs = {
  baseline: Baseline;
  /** All failing links of the run that should be in the baseline (links to fix and ignored links) */
  failures: Pick<LinkWithResult, "href" | "page" | "result">[];
  /**
   * Also remove existing `href` entries that match no failure (fixed links). Only correct when the run checked
   * everything the baseline covers: with file globs, `--include` or sampling, entries of pages that were not
   * checked would be removed. Default `false`: entries are only added.
   */
  prune?: boolean;
  reason?: string;
};

/**
 * Computes the new baseline after a run:
 * - `pattern` entries are always kept (they are hand-written).
 * - Existing `href` entries are kept, with their reason. With `prune`, only if they still match a failure.
 * - Failures not matched by any entry are added as `{ href, page, reason }`.
 */
export const updateBaseline = ({
  baseline,
  failures,
  prune = false,
  reason,
}: UpdateBaselineArgs): BaselineFile => {
  const matched = new Set<BaselineEntry>();
  const added = new Map<string, BaselineEntry>();
  for (const failure of failures) {
    // Every matching entry counts as still in use, not only the first one: an exact `href` entry after a broad
    // pattern that also matches the failure must not be dropped as stale
    const entries = baseline.findEntries(failure);
    for (const entry of entries) {
      matched.add(entry);
    }
    if (entries.length > 0) {
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
    (entry) => entry.href === undefined || !prune || matched.has(entry),
  );
  const newEntries = [...added.values()].toSorted(
    (a, b) =>
      (a.page ?? "").localeCompare(b.page ?? "") || (a.href ?? "").localeCompare(b.href ?? ""),
  );
  return { ignore: [...kept, ...newEntries] };
};

export const writeBaseline = (path: string, file: BaselineFile) => {
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
};
