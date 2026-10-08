import { FileSystem } from "@effect/platform";
import { Effect, ParseResult, Schema } from "effect";
import { BaselineError, getErrorMessage } from "./errors";
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
  /** The first entry matching the (failing) link, if any (its reason is shown in the report) */
  findEntry: (link: { href: string; page: string }) => BaselineEntry | undefined;
  /** All entries matching the link, in file order */
  findEntries: (link: { href: string; page: string }) => BaselineEntry[];
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
  const findEntries = (link: { href: string; page: string }): BaselineEntry[] =>
    compiled.filter(matches(link)).map(({ entry }) => entry);
  return {
    entries,
    findEntry: (link) => findEntries(link)[0],
    findEntries,
  };
};

export const EMPTY_BASELINE = createBaseline([]);

// Own messages: the default ones repeat the (possibly huge) value
const NonEmpty = Schema.String.pipe(
  Schema.minLength(1, { message: () => "expected a non-empty string" }),
);
const Glob = NonEmpty.pipe(
  Schema.maxLength(MAX_GLOB_LENGTH, {
    message: () => `expected at most ${MAX_GLOB_LENGTH} characters`,
  }),
);

// Regular expressions could make the check hang (ReDoS), so point to globs instead
const REGEX_NOT_SUPPORTED = `"regex" is not supported (regular expressions could make the check hang), use a "pattern" glob with * and ** instead`;

const EntrySchema = Schema.Struct({
  href: Schema.optional(NonEmpty),
  pattern: Schema.optional(Glob),
  page: Schema.optional(Glob),
  reason: Schema.optional(NonEmpty),
  regex: Schema.optional(Schema.Never.annotations({ message: () => REGEX_NOT_SUPPORTED })),
})
  .annotations({ identifier: "object" })
  .pipe(
    Schema.filter(
      (entry) =>
        (entry.href === undefined) !== (entry.pattern === undefined) ||
        `expected exactly one of "href" or "pattern"`,
    ),
  );

// A plain string is a shorthand for `{ "pattern": ... }`, a bare array is a shorthand for `{ "ignore": [...] }`
const withShorthands = <A, I>(
  schema: Schema.Schema<A, I>,
  shorthand: (value: unknown) => unknown,
) =>
  Schema.transform(Schema.Unknown, schema, {
    strict: false,
    decode: shorthand,
    encode: (value) => value,
  });

const BaselineFileSchema = withShorthands(
  Schema.Struct({
    $schema: Schema.optional(Schema.Unknown),
    ignore: Schema.Array(
      withShorthands(EntrySchema, (item) => (typeof item === "string" ? { pattern: item } : item)),
    ).annotations({ identifier: "array" }),
  }).annotations({ identifier: "object" }),
  (data) => (Array.isArray(data) ? { ignore: data } : data),
);

/** `ignore[1].href` for the issue path, `baseline` for the root */
const formatPath = (path: ReadonlyArray<PropertyKey>): string =>
  path.reduce<string>(
    (text, key) =>
      typeof key === "number" ? `${text}[${key}]` : `${text}${text ? "." : ""}${String(key)}`,
    "",
  ) || "baseline";

/**
 * First issue only, like a fail-fast check: later ones are often side effects of it.
 * - https://effect.website/docs/schema/error-formatters/
 */
const describeParseError = (error: ParseResult.ParseError): string => {
  const [issue] = ParseResult.ArrayFormatter.formatErrorSync(error);
  return issue ? `${formatPath(issue.path)}: ${issue.message}` : error.message;
};

/**
 * Reads and validates a baseline file. Accepts `{ "ignore": [...] }` or a bare array of entries.
 * @param allowMissing return an empty baseline if the file does not exist (used with `--update-baseline`)
 */
export const loadBaseline = Effect.fn("loadBaseline")(function* (
  path: string,
  { allowMissing = false }: { readonly allowMissing?: boolean } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const invalid = (message: string) =>
    new BaselineError({ message: `Invalid baseline file ${path}: ${message}` });
  const text = yield* fs.readFileString(path).pipe(
    Effect.catchTags({
      SystemError: (error) =>
        error.reason === "NotFound"
          ? Effect.succeed(undefined)
          : Effect.fail(invalid(getErrorMessage(error))),
      BadArgument: (error) => Effect.fail(invalid(getErrorMessage(error))),
    }),
  );
  if (text === undefined) {
    return allowMissing
      ? EMPTY_BASELINE
      : yield* new BaselineError({ message: `Baseline file not found: ${path}` });
  }
  const file = yield* Schema.decodeUnknown(Schema.parseJson(BaselineFileSchema), {
    onExcessProperty: "error",
  })(text).pipe(Effect.mapError((error) => invalid(describeParseError(error))));
  return createBaseline([...file.ignore]);
});

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
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.writeFileString(path, `${JSON.stringify(file, null, 2)}\n`),
  );
