import { readFile, writeFile } from "node:fs/promises";
import { Data, Effect, Option, ParseResult, Schema } from "effect";
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

export class BaselineError extends Data.TaggedError("BaselineError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const NonEmpty = Schema.NonEmptyString;
const Glob = NonEmpty.pipe(Schema.maxLength(MAX_GLOB_LENGTH));

const EntrySchema = Schema.Struct({
  href: Schema.optional(NonEmpty),
  pattern: Schema.optional(Glob),
  page: Schema.optional(Glob),
  reason: Schema.optional(NonEmpty),
  // Never valid: a clear message instead of "unexpected key"
  regex: Schema.optional(
    Schema.Never.annotations({
      message: () =>
        `"regex" is not supported (regular expressions could make the check hang), use a "pattern" glob with * and ** instead`,
    }),
  ),
})
  // Short name in messages instead of a dump of the whole schema
  .annotations({ identifier: "BaselineEntry" })
  .pipe(
    Schema.filter(
      (entry) =>
        (entry.href === undefined) !== (entry.pattern === undefined) ||
        `expected exactly one of "href" or "pattern"`,
    ),
  );

const BaselineSchema = Schema.Struct({
  $schema: Schema.optional(Schema.Unknown),
  ignore: Schema.Array(EntrySchema),
}).annotations({ identifier: "BaselineFile" });

/** A bare array is `{ ignore }`, a plain string entry is a shorthand for `{ "pattern": ... }` */
const normalize = (data: unknown): unknown => {
  const file = Array.isArray(data) ? { ignore: data } : data;
  if (typeof file === "object" && file !== null && "ignore" in file && Array.isArray(file.ignore)) {
    return {
      ...file,
      ignore: file.ignore.map((item: unknown) =>
        typeof item === "string" ? { pattern: item } : item,
      ),
    };
  }
  return file;
};

/** `ignore[0].href` */
const formatPath = (path: ReadonlyArray<PropertyKey>) =>
  path.reduce<string>(
    (text, key) =>
      typeof key === "number" ? `${text}[${key}]` : `${text}${text ? "." : ""}${String(key)}`,
    "",
  );

/**
 * Validates the parsed JSON of a baseline file. Accepts `{ "ignore": [...] }` or a bare array of entries.
 * Fails with a `BaselineError` pointing to the invalid entry.
 */
const validateBaseline = (data: unknown): Effect.Effect<BaselineFile, BaselineError> =>
  Schema.decodeUnknown(BaselineSchema, { onExcessProperty: "error", errors: "first" })(
    normalize(data),
  ).pipe(
    Effect.map(({ ignore }) => ({ ignore: ignore.map(({ regex: _regex, ...entry }) => entry) })),
    Effect.mapError((error) => {
      // Only the first issue, like a fail-fast check: later ones are often side effects of it
      const [issue] = ParseResult.ArrayFormatter.formatErrorSync(error);
      return new BaselineError({
        message: `${formatPath(issue?.path ?? []) || "baseline"}: ${issue?.message}`,
      });
    }),
  );

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
  const findEntries = (link: { href: string; page: string }): BaselineEntry[] =>
    compiled.filter(matches(link)).map(({ entry }) => entry);
  return {
    entries,
    findEntry: (link) => findEntries(link)[0],
    findEntries,
  };
};

export const EMPTY_BASELINE = createBaseline([]);

const isNotFound = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/**
 * Reads and validates a baseline file.
 * @param allowMissing return an empty baseline if the file does not exist (used with `--update-baseline`)
 * Fails with a `BaselineError` if the file is missing, not valid JSON, or not a valid baseline
 */
export const loadBaseline = (path: string, { allowMissing = false } = {}) => {
  const invalid = (cause: unknown) =>
    new BaselineError({
      message: `Invalid baseline file ${path}: ${getErrorMessage(cause)}`,
      cause,
    });
  return Effect.gen(function* () {
    const text = yield* Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (error) => error,
    }).pipe(
      Effect.map(Option.some),
      Effect.catchIf(isNotFound, () => Effect.succeedNone),
      Effect.mapError(invalid),
    );
    if (Option.isNone(text)) {
      return allowMissing
        ? EMPTY_BASELINE
        : yield* new BaselineError({ message: `Baseline file not found: ${path}` });
    }
    const data = yield* Effect.try({ try: (): unknown => JSON.parse(text.value), catch: invalid });
    const file = yield* validateBaseline(data).pipe(Effect.mapError(invalid));
    return createBaseline(file.ignore);
  });
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

export const writeBaseline = (path: string, file: BaselineFile) =>
  Effect.tryPromise({
    try: () => writeFile(path, `${JSON.stringify(file, null, 2)}\n`),
    catch: (cause) =>
      new BaselineError({
        message: `Could not write baseline file ${path}: ${getErrorMessage(cause)}`,
        cause,
      }),
  });
