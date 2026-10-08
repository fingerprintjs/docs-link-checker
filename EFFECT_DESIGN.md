# Effect rewrite: target design

Rewrite of main (`9f89352`) from scratch with Effect 3. The literal port (tag `effect-port`) is reference only.
Base branch for all work: `effect-rewrite`, created from `9f89352` (not from the port).
Verified against installed `effect@3.22.2` and published `.d.ts` / JS of the platform packages (see 1).

Notation:

- `Effect<A, E, R>`, `Layer<A, E, R>`, `Option` etc. are the `effect` types. `E` / `R` omitted means `never`.
- Signatures below are the contract between parallel groups. A group must not change a signature owned by another group.
- Every module file starts with a short overview comment (CODING_STANDARDS.md).

## 1. Dependencies

Final `package.json` deltas (STEP 1 only, no other group touches `package.json`, lockfile, tsconfig, vitest configs).

| Package                        | Version                                                                                               | Why                                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `effect`                       | `^3.22.2` (installed)                                                                                 | core                                                                                           |
| `@effect/platform`             | `^0.97.2`                                                                                             | `FileSystem` service + `PlatformError` (peer `effect ^3.22.2`)                                 |
| `@effect/platform-node-shared` | `^0.61.1`                                                                                             | `NodeFileSystem.layer` (import the subpath `@effect/platform-node-shared/NodeFileSystem`)      |
| `@effect/vitest` (dev)         | `0.30.0` (pinned)                                                                                     | `it.effect`, `it.scoped`, `it.live`, `layer`, TestClock. Last 3.x line (`4.x` is for effect 4) |
| removed                        | `p-limit`, `zod`                                                                                      | replaced by `Effect.makeSemaphore` and `Schema`                                                |
| kept                           | `commander`, `@octokit/*`, `playwright`, `cheerio`, `preact`, `mdast-*`, `github-slugger`, `tsx`, ... | see 3 (CLI, Octokit)                                                                           |

Not added: `@effect/cli`, `@effect/platform-node` (barrel), `@effect/printer*`, `@effect/typeclass`, `@effect/rpc|sql|cluster`.

Verified in a scratch project (not in the repo):

- `@effect/vitest@0.30.0` declares `peer vitest ^3.2`, but runs with `vitest@5.0.3` (`it.effect` + `TestClock.adjust`, `it.scoped`, `it.live` pass, `tsc` passes). Silence the peer warning with
  `"pnpm": { "peerDependencyRules": { "allowedVersions": { "@effect/vitest>vitest": "5" } } }`.
- `@effect/platform-node-shared` has non-optional peers `@effect/rpc|sql|cluster`: pnpm would auto-install 7 unused packages (rpc, sql, cluster, workflow, experimental, ...). Fix (verified, +21 packages total, no extras):
  `"pnpm": { "packageExtensions": { "@effect/platform-node-shared": { "peerDependenciesMeta": { "@effect/rpc": { "optional": true }, "@effect/sql": { "optional": true }, "@effect/cluster": { "optional": true } } } } }`
- Importing the `@effect/platform-node` barrel crashes without `@effect/cluster` (ERR_MODULE_NOT_FOUND). Only import subpaths of `platform-node-shared`.
- `pnpm.onlyBuiltDependencies` stays `["esbuild"]`: `@parcel/watcher` and `msgpackr-extract` build scripts stay ignored (optional natives, not needed).
- Confirmed in the repo in STEP 1: `pnpm install` adds 17 packages and removes `p-limit`, `zod`, no peer warnings, `@effect/rpc|sql|cluster` are not installed, `pnpm install --frozen-lockfile`, `pnpm tsc`, `pnpm test` pass (Node 22 here, `engines` says >=24, only a pnpm warning).

## 2. Module map and contracts

Target `src/` tree. `(=)` means unchanged domain code, copied from main as is (only `console.*` -> logging if it has any).
Owner = group in 4.

### 2.1 Foundation (STEP 1)

```
src/types.ts            (=) Link, LinkWithResult, LinkCheckResult
src/errors.ts           typed errors
src/config.ts           Config values, option parsers, .env provider
src/logger.ts           plain-text logger layer
src/metrics.ts          per-run counters, phases, end-of-run summary
src/limiter.ts          per-host slots + host pause
src/http.ts             Fetch service, limited fetch with redirects/retries, status rules
src/utils.ts            processAll, sampleItems, compareStrings
src/app.ts              layer wiring + runLive for scripts
src/hash.ts             (=)
src/line_anchor.ts      (=)
src/markdown.ts         (=)
src/glob.ts             (=)
src/github/gh_url.ts    (=)
src/test/*.ts           test utilities (2.6)
+ stubs of every file owned by the groups (see 4, STEP 1)
```

#### `src/errors.ts`

```ts
export const getErrorMessage: (error: unknown) => string; // Error -> message, else String(error)

// All are Data.TaggedError. `message` is a getter unless it is a field.
export class FetchError extends Data.TaggedError("FetchError")<{
  readonly url: string;
  readonly cause: unknown;
}> {}
//   message = getErrorMessage(cause); toString() = String(cause) (reports show "TypeError: fetch failed" like before)
export class TooManyRedirects extends Data.TaggedError("TooManyRedirects")<{
  readonly url: string;
  readonly maxRedirects: number;
}> {}
//   message = `Too many redirects (more than ${maxRedirects}) for ${url}`
export class HttpStatusError extends Data.TaggedError("HttpStatusError")<{
  readonly url: string;
  readonly status: number;
  readonly message: string;
}> {} // callers pass the exact old message: "Could not fetch X, status: N", "Could not download X, status: N", "Could not fetch sitemap X: status N"
export class GitHubApiError extends Data.TaggedError("GitHubApiError")<{
  readonly status: number | undefined;
  readonly cause: unknown;
}> {
  get isNotFound(): boolean;
} // status 404 or 410. message = getErrorMessage(cause), toString() = String(cause)
export class GitHubTimeout extends Data.TaggedError("GitHubTimeout")<{
  readonly message: string;
}> {}
//   message `GitHub API check timed out after ${TASK_TIMEOUT}ms`. NOT a link result: propagates as the check's failure (-> "unexpected error", no Playwright re-check, like main)
export class OrgListError extends Data.TaggedError("OrgListError")<{
  readonly org: string;
  readonly cause: unknown;
}> {}
//   message = `Failed to list repositories of GitHub organization ${org}: ${getErrorMessage(cause)}`
export class BrowserLaunchError extends Data.TaggedError("BrowserLaunchError")<{
  readonly cause: unknown;
}> {}
export class BrowserCrashed extends Data.TaggedError("BrowserCrashed")<{
  readonly cause: unknown;
}> {} // browser disconnected during a page operation
export class PlaywrightError extends Data.TaggedError("PlaywrightError")<{
  readonly cause: unknown;
}> {}
export class NoMarkdownFiles extends Data.TaggedError("NoMarkdownFiles")<{
  readonly patterns: ReadonlyArray<string>;
}> {}
//   message = `No markdown files match ${patterns.map((p) => `"${p}"`).join(", ")}.`
export class UsageError extends Data.TaggedError("UsageError")<{ readonly message: string }> {} // exit code 2
export class BaselineError extends Data.TaggedError("BaselineError")<{
  readonly message: string;
}> {} // exit code 2
```

#### `src/config.ts`

```ts
export const DEFAULT_HOST_CONCURRENCY = 8;

// Pure parsers of non-blank values. `label` is the flag or variable name used in the message.
export const parseSampleRate: (value: string, label: string) => Either<number, string>;
//   Left: `Invalid ${label} "${value}", expected a number between 0 and 1.`
export const parseHostConcurrency: (value: string, label: string) => Either<number, string>;
//   Left: `Invalid ${label} "${value}", expected a positive integer.`

// Env defaults of CLI options as raw strings ("" = unset). Parsed by the CLI only when the flag is absent
// (so --help and flags that override an invalid env value still work).
export const EnvOptions: Config.Config<{
  readonly sampleRate: string; // LINK_CHECK_SAMPLE_RATE
  readonly hostConcurrency: string; // LINK_CHECK_HOST_CONCURRENCY
  readonly failOnBroken: string; // FAIL_ON_BROKEN_LINKS ("false" = do not fail)
  readonly baseline: string; // LINK_CHECK_BASELINE
}>;

export const GithubToken: Config.Config<Option<Redacted<string>>>; // GH_TOKEN, "" = None

export type ActionsEnv = {
  readonly actions: string | undefined; // GITHUB_ACTIONS
  readonly serverUrl: string | undefined; // GITHUB_SERVER_URL
  readonly repository: string | undefined; // GITHUB_REPOSITORY
  readonly sha: string | undefined; // GITHUB_SHA
  readonly workspace: string | undefined; // GITHUB_WORKSPACE
  readonly output: string | undefined; // GITHUB_OUTPUT
  readonly stepSummary: string | undefined; // GITHUB_STEP_SUMMARY
};
export const ActionsEnvConfig: Config.Config<ActionsEnv>; // an empty variable counts as unset (undefined)

// Provider for production: real env vars first, then `.env` of the process cwd (same precedence as process.loadEnvFile)
export const loadDotEnv: Effect<ConfigProvider.ConfigProvider, never, FileSystem.FileSystem>; // uses util.parseEnv
```

#### `src/logger.ts`

```ts
// Plain text, no timestamp/level. Info -> console.info (stdout), Warning/Error -> stderr.
// json: everything to stderr (stdout is only the JSON report).
export const LogLayer: (options: { readonly json: boolean }) => Layer<never>;
//   = Logger.replace(Logger.defaultLogger, json ? Logger.withConsoleError(plain) : Logger.withLeveledConsole(plain))
```

#### `src/metrics.ts`

```ts
export const METRICS: { readonly [name: string]: string }; // same names and labels as main's run.ts, `as const`
export type MetricName = keyof typeof METRICS;
export type MetricsSnapshot = {
  readonly counters: Readonly<Record<string, number>>;
  readonly phases: ReadonlyArray<{ readonly name: string; readonly ms: number }>;
  readonly totalMs: number; // since the layer was built (Clock)
};
export const formatRunMetrics: (snapshot: MetricsSnapshot) => string; // exactly main's text ("Run metrics:\n  Total links: ...")
export class Metrics extends Context.Tag("Metrics")<
  Metrics,
  {
    readonly increment: (name: MetricName, by?: number) => Effect<void>;
    readonly timePhase: <A, E, R>(name: string, effect: Effect<A, E, R>) => Effect<A, E, R>; // records also on failure
    readonly snapshot: Effect<MetricsSnapshot>;
  }
>() {
  // Scoped: state in Refs, finalizer logs formatRunMetrics(...) with logInfo (also on failure/interrupt)
  static readonly layer: Layer<Metrics>;
}
```

#### `src/limiter.ts`

```ts
export class HostLimiter extends Context.Tag("HostLimiter")<
  HostLimiter,
  {
    // Runs `effect` in a free slot of the URL's host, after the host pause ended (checked inside the slot, re-checked while paused).
    // Waiters are woken in order, but a retry that releases and re-takes can overtake them.
    // Unparsable URLs are not limited (the request itself fails).
    readonly withSlot: <A, E, R>(url: string, effect: Effect<A, E, R>) => Effect<A, E, R>;
    // Waits until the host is not paused, without a slot (Playwright navigations).
    readonly waitUntilResumed: (url: string) => Effect<void>;
    // Pauses new requests to the host for `ms` (never shortens an existing pause). Time from Clock.
    readonly pause: (url: string, ms: number) => Effect<void>;
  }
>() {
  static readonly layer: (hostConcurrency: number) => Layer<HostLimiter>;
}
```

#### `src/http.ts`

```ts
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;
// The only place `globalThis.fetch` is referenced. Faked in tests, also passed to Octokit (`request.fetch`).
export class Fetch extends Context.Tag("Fetch")<Fetch, FetchFn>() {
  static readonly layer: Layer<Fetch>;
}

export const TASK_TIMEOUT = 80_000; // GitHub API request timeout, longest Retry-After waited for on a 429
export const USER_AGENT: string; // same value as main
export const getUserAgent: (url: string) => string | undefined; // undefined for android.com
export const classifyStatus: (status: number) => "okay" | "forbidden" | "server-error" | "other"; // same sets as main

export const parseRetryAfter: (value: string | null, now: number) => number | undefined; // ms, seconds or HTTP date; now = Clock time

// 502/503/504 retry rule shared by fetch and Playwright. Logs "Server error ..., retrying after Ns..." and counts
// `serverErrorRetries` when it returns Some(delayMs). None = give up (retries >= 2, or Retry-After > 10s).
export const planServerErrorRetry: (args: {
  readonly url: string;
  readonly status: number;
  readonly retries: number;
  readonly retryAfter: string | null;
}) => Effect<Option<number>, never, Metrics>;
export const serverErrorResult: (status: number, statusText: string) => LinkCheckResult; // same text as main

export type LimitedResponse<T> = {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly url: string; // final URL after redirects
  readonly data: T; // what `read` returned for the final response
};
export type LimitedRequestOptions = {
  readonly method?: "GET" | "HEAD"; // default GET, kept across redirects
  readonly headers?: HeadersInit;
  readonly timeoutMs?: number; // per hop, default 20_000
};
// Semantics = main's fetchWithHostLimit (see 3, "retries"). `read` runs inside the slot, unread bodies are cancelled before the slot is released.
export const fetchLimited: <T>(
  url: string,
  options: LimitedRequestOptions,
  read: (response: Response) => Promise<T>,
) => Effect<LimitedResponse<T>, FetchError | TooManyRedirects, Fetch | HostLimiter | Metrics>;
```

#### `src/utils.ts`

```ts
export const CONCURRENCY_LIMIT = 100;
export const compareStrings: (a: string, b: string) => number; // code unit order
export type ItemError<T> = { readonly item: T; readonly error: unknown };
// Effect.forEach with bounded concurrency, results and errors in item order. A failing or dying item does not stop the others
// (each item runs under Effect.exit; error = Cause.squash). Logs: "Progress: done/total" every 30s (Schedule.spaced, forkScoped),
// "Errors processing items: N\n  - <describeItem>: <message>" (logError), "Time taken: Nms" (also on interrupt).
export const processAll: <T, A, E, R>(args: {
  readonly items: ReadonlyArray<T>;
  readonly process: (item: T) => Effect<A, E, R>;
  readonly concurrency?: number; // default CONCURRENCY_LIMIT
}) => Effect<{ results: A[]; errors: ItemError<T>[] }, never, R>;
// Deterministic sample (same algorithm as main). `rate` is required: no env fallback here.
export const sampleItems: <T>(args: {
  readonly items: ReadonlyArray<T>;
  readonly key: (item: T) => string;
  readonly rate: number;
  readonly label?: string;
}) => Effect<T[]>; // logs "Sampling N of M <label> (sample rate r)." when sampling
```

#### `src/app.ts`

```ts
export type RunSettings = { readonly hostConcurrency: number };
// Everything a link check needs. `Chromium` is internal to Browser.layer.
export type RunServices = Fetch | Metrics | HostLimiter | GitHub | Browser;
// One per run (a CLI command, a bench round): fresh Metrics, HostLimiter, caches, lazy browser. Closed at the end of the run.
export const liveRunLayer: (settings: RunSettings) => Layer<RunServices>;
//   Layer.mergeAll(HostLimiter.layer(n), GitHub.layer, Browser.layer)
//     .pipe(Layer.provideMerge(Layer.mergeAll(Metrics.layer, Fetch.layer, Chromium.layer)))
// For scripts (bench, checks/gh_rate_limit): LogLayer({json:false}) + liveRunLayer + Effect.runPromise.
export const runLive: <A, E>(
  effect: Effect<A, E, RunServices>,
  settings?: RunSettings,
) => Promise<A>;
```

### 2.2 GITHUB group: `src/github/*`

```
src/github/github_client.ts       GitHub service (typed API methods, Octokit inside, caches, metrics, timeouts)
src/github/gh_api.ts              failed API call -> LinkCheckResult
src/github/checks/gh_simple.ts    existence checks: repo, owner, commit, PR, issue, discussion, release
src/github/checks/gh_content.ts   blob / tree checks (ref with slashes, hashes, line anchors)
src/github/gh_check_link.ts       URL -> check dispatch
src/github/gh_get_links.ts        org READMEs -> links -> checkLinks
tests: gh_api, gh_check_link, gh_get_links, gh_simple, gh_content, github_client (+ the 3 *.integration.test.ts kept)
```

#### `src/github/github_client.ts` (interface frozen in STEP 1, implementation here)

```ts
// Only the fields the checks read, so fakes stay small.
export type RepoInfo = { readonly default_branch: string };
export type FileInfo = {
  readonly content: string;
  readonly encoding?: string;
  readonly sha: string;
  readonly size?: number;
};
export type ContentInfo = FileInfo | { readonly content?: undefined }; // file, or directory listing / symlink / submodule
export type ReleaseInfo = { readonly assets: ReadonlyArray<{ readonly name: string }> };
export type OrgRepo = {
  readonly full_name: string;
  readonly name: string;
  readonly archived?: boolean;
  readonly owner: { readonly login: string };
};
export type TreeEntry = { readonly type?: string; readonly path?: string };
export type FileText = {
  readonly text: string;
  readonly binary: boolean;
  readonly getAnchors: () => Set<string>;
}; // anchors parsed once, lazily
export type GitHubError = GitHubApiError | GitHubTimeout;

export type GitHubApi = {
  readonly getRepo: (owner: string, repo: string) => Effect<RepoInfo, GitHubError>; // cached (lowercase key)
  readonly getUser: (username: string) => Effect<void, GitHubError>; // user or org, cached
  readonly getCommit: (owner: string, repo: string, ref: string) => Effect<void, GitHubError>;
  readonly getPullRequest: (
    owner: string,
    repo: string,
    number: number,
  ) => Effect<void, GitHubError>;
  readonly getIssue: (owner: string, repo: string, number: number) => Effect<void, GitHubError>;
  readonly getDiscussion: (
    owner: string,
    repo: string,
    number: number,
  ) => Effect<void, GitHubError>; // GraphQL NOT_FOUND -> GitHubApiError status 404
  readonly getReleaseByTag: (
    owner: string,
    repo: string,
    tag: string,
  ) => Effect<ReleaseInfo, GitHubError>;
  readonly getRelease: (
    owner: string,
    repo: string,
    releaseId: number,
  ) => Effect<void, GitHubError>;
  readonly hasReleases: (owner: string, repo: string) => Effect<boolean, GitHubError>;
  readonly getContent: (
    owner: string,
    repo: string,
    ref: string,
    path: string,
  ) => Effect<ContentInfo, GitHubError>; // cached
  readonly listRefNames: (
    owner: string,
    repo: string,
    kind: "heads" | "tags",
    prefix: string,
  ) => Effect<ReadonlyArray<string>, GitHubError>; // matching refs, all pages, names without `refs/<kind>/`, cached
  readonly getFileText: (
    owner: string,
    repo: string,
    file: FileInfo,
  ) => Effect<FileText, GitHubError>; // base64 decode, blobs API for files > 1 MB, cached by sha
  readonly listOrgRepos: (org: string) => Effect<ReadonlyArray<OrgRepo>, GitHubError>; // public repos, all pages
  readonly getTreeEntries: (
    owner: string,
    repo: string,
    ref: string,
  ) => Effect<ReadonlyArray<TreeEntry>, GitHubError>; // recursive tree
  readonly getRateLimit: Effect<
    { readonly remaining: number; readonly reset: number },
    GitHubError
  >;
};
export class GitHub extends Context.Tag("GitHub")<GitHub, GitHubApi>() {
  static readonly layer: Layer<GitHub, never, Fetch | Metrics>;
}
```

#### `src/github/gh_api.ts`

```ts
// "not found" (404/410) -> broken link with `notFoundDetail`, anything else -> unexpected error with errorDetail String(error). Same output as main.
export const getApiErrorResult: (error: GitHubApiError, notFoundDetail: string) => LinkCheckResult;
```

#### `src/github/checks/gh_simple.ts`, `gh_content.ts`, `gh_check_link.ts`, `gh_get_links.ts`

```ts
// gh_simple.ts. R = GitHub. Only GitHubTimeout can fail (GitHubApiError becomes a result).
export const checkIfRepositoryExists: (
  owner: string,
  repo: string,
) => Effect<LinkCheckResult, GitHubTimeout, GitHub>;
export const checkIfOwnerExists: (owner: string) => Effect<LinkCheckResult, GitHubTimeout, GitHub>;
export const checkGitHubCommitLink: (
  owner: string,
  repo: string,
  pathParts: string[],
) => Effect<LinkCheckResult, GitHubTimeout, GitHub>; // 422 -> "Commit not found"
export const checkGitHubPullRequestLink: (
  owner: string,
  repo: string,
  pathParts: string[],
) => Effect<LinkCheckResult, GitHubTimeout, GitHub>;
export const checkGitHubIssueLink: (
  owner: string,
  repo: string,
  pathParts: string[],
) => Effect<LinkCheckResult, GitHubTimeout, GitHub>;
export const checkGitHubDiscussionLink: (
  owner: string,
  repo: string,
  discussionNumber: number,
) => Effect<LinkCheckResult, GitHubTimeout, GitHub>;
export const checkGitHubReleaseLink: (
  owner: string,
  repo: string,
  pathParts: string[],
) => Effect<LinkCheckResult, GitHubTimeout, GitHub>;

// gh_content.ts
export const checkGitHubBlobLink: (
  fullUrl: URL,
  owner: string,
  repo: string,
  pathParts: string[],
) => Effect<LinkCheckResult, GitHubTimeout, GitHub>;
export const checkGitHubTreeLink: (
  owner: string,
  repo: string,
  pathParts: string[],
) => Effect<LinkCheckResult, GitHubTimeout, GitHub>;

// gh_check_link.ts
export const checkLinkWithGithubApi: (
  url: string,
) => Effect<LinkCheckResult, GitHubTimeout, GitHub | Fetch | HostLimiter | Metrics>;

// gh_get_links.ts
export type MdFile = { readonly sourcePath: string; readonly downloadUrl: string };
export const getReadmesFromOrg: (
  org: string,
  sampleRate: number,
) => Effect<MdFile[], OrgListError, GitHub>;
export const resolveReadmeHref: (href: string, page: string) => string; // pure, unchanged
export const getReadmeLinks: (
  files: ReadonlyArray<MdFile>,
) => Effect<Link[], never, Fetch | HostLimiter | Metrics>;
export const getGithubOrgSiteName: (org: string) => string;
export const checkReadmesInGithubOrg: (
  org: string,
  options: { readonly sampleRate: number },
) => Effect<LinkWithResult[], OrgListError, RunServices>;
```

### 2.3 BROWSER group

```
src/browser.ts           Chromium + Browser services (lazy shared browser, page slots, crash retry)
src/playwright_check.ts  checks the hashes of URLs of one page in the DOM
src/test/fake_chromium.ts  cheerio-based fake Chromium (port of main's link.test fake + browser.test state machine)
tests: browser.test.ts, playwright_check.test.ts (split out of main's link.test.ts)
```

```ts
// browser.ts
export const PLAYWRIGHT_CONCURRENCY_LIMIT = 5;
// The only place `chromium` is referenced. Faked in tests instead of vi.mock("playwright").
export class Chromium extends Context.Tag("Chromium")<Chromium, Pick<BrowserType, "launch">>() {
  static readonly layer: Layer<Chromium>;
}
// Promise-returning Playwright call -> Effect (the only try/catch of Playwright errors)
export const tryPlaywright: <A>(f: () => Promise<A>) => Effect<A, PlaywrightError>;
export class Browser extends Context.Tag("Browser")<
  Browser,
  {
    // Fresh page in its own context of the shared browser. At most 5 pages at a time. Images/media/fonts/analytics blocked.
    // If the browser crashed (disconnected) it is relaunched and `use` runs again once, then the original error surfaces.
    readonly withPage: <A, E, R>(
      options: { readonly userAgent?: string; readonly timeout: number },
      use: (page: Page) => Effect<A, E, R>,
    ) => Effect<A, E | BrowserLaunchError | PlaywrightError, R>;
  }
>() {
  static readonly layer: Layer<Browser, never, Chromium | Metrics>;
}

// playwright_check.ts
export const PAGE_OPERATION_TIMEOUT = 30_000;
export const HASH_WAIT_TIMEOUT = 3_000;
export const HASH_FALLBACK_WAIT_TIMEOUT = 15_000;
export const checkUrlsOnPageWithPlaywright: (
  urls: ReadonlyArray<string>,
) => Effect<
  Map<string, LinkCheckResult>,
  BrowserLaunchError | PlaywrightError,
  Browser | HostLimiter | Metrics
>;
```

### 2.4 PIPELINE group

```
src/fetch_check.ts    page fetch + hash check with plain fetch, one fetch per page (Cache)
src/link.ts           checkLinks: first pass (fetch / GitHub API), Playwright re-check
src/page.ts           links of website pages, irrelevant link filter
src/sitemap.ts        sitemap(s) -> page URLs
src/website.ts        `site` command check
src/local_files.ts    `files` command: glob, local link checks, external links
tests: fetch_check, link, page, sitemap, website, local_files (+ link.integration.test.ts kept)
```

```ts
// fetch_check.ts
export type FetchedPage =
  | { readonly ok: true; readonly status: number; readonly getAnchors?: () => AnchorIndex }
  | { readonly ok: false; readonly result: LinkCheckResult };
export type PageCache = Cache.Cache<string, FetchedPage>; // key: page URL without hash
// Cache.make, infinite TTL, lookup = fetchPage(url, { needBody: pagesWithHash.has(url) }), counts `uniquePagesFetched` on a miss.
export const makePageCache: (
  pagesWithHash: ReadonlySet<string>,
) => Effect<PageCache, never, Fetch | HostLimiter | Metrics>;
// Never fails: network errors / bad statuses are results. Without a cache each call fetches (needBody = hasHash(url)).
export const checkLinkWithFetch: (
  url: string,
  pageCache?: PageCache,
) => Effect<LinkCheckResult, never, Fetch | HostLimiter | Metrics>;

// link.ts
export const interleaveByHost: <T extends { href: string }>(items: ReadonlyArray<T>) => T[]; // pure, unchanged
export const checkLinks: (args: {
  readonly links: ReadonlyArray<Link>;
  readonly fetchConcurrencyLimit?: number; // default CONCURRENCY_LIMIT
}) => Effect<LinkWithResult[], never, RunServices>; // a failing check is an "unexpected error" result, like main

// page.ts
export const filterOutIrrelevantLinks: (links: ReadonlyArray<Link>) => Link[]; // pure, unchanged
export const getLinksFromPages: (args: {
  readonly pages: ReadonlyArray<string>;
  readonly linkFilter?: (link: Link) => boolean;
}) => Effect<{ links: Link[]; errors: ItemError<string>[] }, never, Fetch | HostLimiter | Metrics>;

// sitemap.ts
export const MAX_SITEMAP_DEPTH = 3;
export const getWebsitePages: (
  url: string,
) => Effect<
  string[],
  FetchError | TooManyRedirects | HttpStatusError,
  Fetch | HostLimiter | Metrics
>;

// website.ts
export const createPrefixFilter: (prefixes: ReadonlyArray<string>) => (link: Link) => boolean; // pure, unchanged
export const checkWebsite: (args: {
  readonly websiteUrl: string;
  readonly linkFilter?: (link: Link) => boolean;
  readonly sampleRate: number;
}) => Effect<LinkWithResult[], FetchError | TooManyRedirects | HttpStatusError, RunServices>;

// local_files.ts
export const LOCAL_FILES_SITE_NAME = "local files";
export type CollectedLinks = { files: string[]; local: Link[]; external: Link[]; skipped: Link[] }; // same as main
export type LocalCheckContext = {
  readonly root: string;
  readonly anchorsOf: (absolutePath: string) => Effect<Set<string>, PlatformError>;
};
export const checkLocalLink: (
  file: string,
  href: string,
  context: LocalCheckContext,
) => Effect<LinkCheckResult, never, FileSystem.FileSystem>;
export const collectLinksFromFiles: (args: {
  readonly patterns: ReadonlyArray<string>;
  readonly cwd: string;
  readonly sampleRate: number;
}) => Effect<CollectedLinks, NoMarkdownFiles | PlatformError, FileSystem.FileSystem>;
export const checkLocalFiles: (args: {
  readonly patterns: ReadonlyArray<string>;
  readonly cwd: string;
  readonly sampleRate: number;
}) => Effect<
  LinkWithResult[],
  NoMarkdownFiles | PlatformError,
  FileSystem.FileSystem | RunServices
>;
```

### 2.5 CLI + ACTION + REPORT + BENCH group

```
src/baseline.ts            baseline file: Schema validation, matching, update, write
src/report/report.tsx      (= rendering, pure) + saveReport as Effect
src/github_actions.ts      job summary, annotations, outputs, blob base URL
src/cli.ts                 commander parsing + Effect program, exit codes
bin/docs-link-checker.js   unchanged (calls runCli)
bench/bench.ts             uses liveRunLayer/Metrics.snapshot, Schema for the round file
checks/gh_rate_limit.ts    uses GitHub.getRateLimit
tests: baseline, report, github_actions, cli
```

```ts
// baseline.ts
export type BaselineEntry = { href?: string; pattern?: string; page?: string; reason?: string };
export type BaselineFile = { ignore: BaselineEntry[] };
export const DEFAULT_BASELINE_FILE = "linkcheck.baseline.json";
export type Baseline = {
  entries: BaselineEntry[];
  findEntry: (link: { href: string; page: string }) => BaselineEntry | undefined;
  findEntries: (link: { href: string; page: string }) => BaselineEntry[];
};
export const createBaseline: (entries: BaselineEntry[]) => Baseline; // pure, unchanged
export const EMPTY_BASELINE: Baseline;
export const loadBaseline: (
  path: string,
  options?: { readonly allowMissing?: boolean },
) => Effect<Baseline, BaselineError, FileSystem.FileSystem>;
//   Schema.parseJson(BaselineFileSchema) (see 3 "Schema"). Messages: `Baseline file not found: ${path}`, `Invalid baseline file ${path}: <path>: <message>`.
export const updateBaseline: (args: {
  baseline: Baseline;
  failures: Pick<LinkWithResult, "href" | "page" | "result">[];
  prune?: boolean;
  reason?: string;
}) => BaselineFile; // pure, unchanged
export const writeBaseline: (
  path: string,
  file: BaselineFile,
) => Effect<void, PlatformError, FileSystem.FileSystem>;

// report/report.tsx: getJSONReport, getLinksToFix, renderReportToHTML, getReportPaths, DEFAULT_OUTPUT_DIR, LinkCheckReport, RenderOptions: unchanged (pure)
export const saveReport: (
  report: LinkCheckReport,
  outputDir?: string,
  options?: RenderOptions,
) => Effect<{ json: string; html: string }, PlatformError, FileSystem.FileSystem>; // mkdir -p, writes, logInfo "Saved JSON report to ..." / "Saved HTML report to ..."

// github_actions.ts: describeResult, renderJobSummary, getFileAnnotations: unchanged (pure)
export const getGithubBlobBaseUrl: (env: ActionsEnv, cwd: string) => string | undefined; // pure, same rules
export const writeJobSummary: (
  report: LinkCheckReport,
  options: SummaryOptions,
  summaryFile: string | undefined,
) => Effect<boolean, PlatformError, FileSystem.FileSystem>; // appends
export const writeGithubOutputs: (
  outputs: Record<string, string | number>,
  outputFile: string | undefined,
) => Effect<boolean, PlatformError, FileSystem.FileSystem>; // multi-line value = Effect.dieMessage (programmer error)

// cli.ts
export type CommonOptions = {/* same fields as main */};
export const formatFileProblems: (report: LinkCheckReport) => string[]; // pure, unchanged
export type CliOptions = {
  readonly cwd?: string; // default process.cwd(); globs, baseline, root-relative links
  readonly runLayer?: (settings: RunSettings) => Layer<RunServices>; // default liveRunLayer; tests pass fakes
};
// Never fails: returns the exit code (0 ok, 1 links to fix or crash, 2 usage/baseline). Output only through Console + Logger.
// R = FileSystem (baseline, reports, outputs). Env and `.env` come from the ambient ConfigProvider.
export const runCliEffect: (
  argv: ReadonlyArray<string>,
  options?: CliOptions,
) => Effect<number, never, FileSystem.FileSystem>;
// Production wiring used by bin: NodeFileSystem + loadDotEnv + SIGINT/SIGTERM abort (see 3 "timeouts and cancellation").
export const runCli: (argv: string[]) => Promise<number>;
```

### 2.6 Test utilities (`src/test/`, STEP 1 unless noted)

```ts
// fake_fetch.ts
export type FetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>;
export const fakeFetch: (handler: FetchHandler) => {
  readonly layer: Layer<Fetch>;
  readonly calls: Array<{ readonly url: string; readonly init: RequestInit }>;
};
//   rejects with an AbortError when init.signal aborts (timeouts and interruption work)
// fake_github.ts
export const fakeGitHub: (overrides: Partial<GitHubApi>) => {
  readonly layer: Layer<GitHub>;
  readonly calls: string[];
};
//   non-overridden methods die with "unexpected GitHub call: <method>". `calls` has one entry per call: `method(arg1, arg2)`, arguments as JSON (`getRateLimit` has no parentheses)
// test_console.ts
export const makeTestConsole: () => {
  readonly console: Console.Console;
  readonly stdout: string[];
  readonly stderr: string[];
};
//   log/info/debug -> stdout, warn/error -> stderr, also on `unsafe` (the leveled logger writes there). Use with Effect.withConsole.
// layers.ts
// An unset `fetch` rejects with `unexpected fetch: <url>` (a Promise cannot die: it shows up as the link's result), unset `github` / `browser` die on use
export const testRunLayer: (options?: {
  readonly fetch?: Layer<Fetch>;
  readonly github?: Layer<GitHub>;
  readonly browser?: Layer<Browser>;
  readonly hostConcurrency?: number;
}) => Layer<RunServices>; // real Metrics + HostLimiter; unset fetch/github/browser die on use
// clock.ts
export const runWithClock: <A, E, R>(
  effect: Effect<A, E, R>,
  duration: Duration.DurationInput,
) => Effect<A, E, R>;
//   fork effect, TestClock.adjust(duration) in steps of 100ms (a real macrotask between steps so promise-based fakes settle), join.
//   Sleeps wake up to one step late: use TestClock.adjust + `settle` (also exported, same file) when exact times matter
// fake_chromium.ts (BROWSER group)
export const fakeChromium: (state: FakeChromiumState) => Layer<Chromium>; // port of main's fake, cheerio evaluates selectors
```

## 3. Cross-cutting decisions

Each bullet: feature, why. "No" bullets say why a feature does not pay.

### Layers and app wiring

- **Per-run `Layer`** (`liveRunLayer`): `Metrics`, `HostLimiter`, `GitHub` (caches), `Browser` are built per run and closed at the end. Replaces `withRun` + `AsyncLocalStorage` + module-level default context. No module-level mutable state anywhere (also no `WeakMap` caches: `gh_content.ts` WeakMaps become `GitHub.getFileText`).
- Services are `Context.Tag` classes with a `static layer`, not `Effect.Service`: explicit, fakes are plain `Layer.succeed(Tag, impl)`, no class-instance wrapper, no `dependencies` baking layers into `Default`.
- Wiring is only in `app.ts` (`liveRunLayer`) and in `cli.ts` (per-command: `Effect.provide(runLayer(settings))` around the check part only). `Metrics` finalizer logs the summary, so it is built first and closed last. The browser closes before the summary is logged (reverse build order, Browser depends on Metrics).
- The run layer wraps only the part of a command that checks links. Baseline loading, `--dry-run`, usage errors do not print "Run metrics:" (same as main).
- Leaf services `Fetch`, `Chromium`, `FileSystem` are the only places touching `fetch`, `chromium`, `node:fs`. Everything else is replaceable in tests. One exception: `node:fs/promises` `glob` in `local_files.ts` (no `FileSystem.glob`), wrapped once in `Effect.tryPromise`.
- Convention for all code in `src/` (enforce with oxlint `no-console`, `no-restricted-imports` for `node:fs`, `no-restricted-globals` for `fetch`/`setTimeout`/`process.env`; `src/test/**`, `bin`, `bench`, `checks` excepted): no `console.*`, `process.env`, `Date.now()`, `performance.now()`, `setTimeout`, `fetch`, `throw` for expected failures. Time = `Clock`/`Effect.sleep`, env = `Config`, logs = `Effect.log*`.
- `Effect.fn("module.name")(function* (...) {...})` for exported multi-step functions (named stack traces). Plain `Effect.gen` for local ones.

### Config

- **`Config`** + ambient `ConfigProvider`: replaces every `process.env` read (`GH_TOKEN`, `LINK_CHECK_*`, `FAIL_ON_BROKEN_LINKS`, `GITHUB_*`) and `process.loadEnvFile`. Tests use `Effect.withConfigProvider(ConfigProvider.fromMap(...))` instead of passing `env` objects around. `.env`: `loadDotEnv` = `ConfigProvider.fromEnv().pipe(ConfigProvider.orElse(() => fromMap(parsed .env)))` (env vars win, like before).
- CLI env defaults are read as raw strings and parsed by the CLI only when the flag is absent, with `UsageError` messages identical to main (`Invalid LINK_CHECK_SAMPLE_RATE "abc", expected a number between 0 and 1.`). Using typed `Config.number` would turn those into `ConfigError` text.
- `GH_TOKEN` is `Config.redacted`, read when `GitHub.layer` is built, the Octokit client is created lazily on first call (`Effect.cached`); a missing token is a `GitHubApiError` with main's text `GH_TOKEN is not set. A GitHub token is required to check GitHub links.`, not a crash.

### Logging and `--json`

- **`Effect.log*` + custom `Logger`** (`LogLayer`): 37 `console.*` calls become `logInfo` (`console.log`), `logWarning` (`console.warn`), `logError` (`console.error`), same text. Plain logger prints only the message. `Logger.withLeveledConsole` gives main's stream split (info -> stdout, warn/error -> stderr).
- `--json`: `LogLayer({ json: true })` = `Logger.withConsoleError`, all logs to stderr. This replaces the `globalThis.console = new Console(...)` swap. The report JSON, `--dry-run` listing and annotation lines are written with `Console.log` / `Console.error` explicitly (annotations go to stderr only in `--json`, like main). stdout therefore stays clean JSON.
- Commander's help/usage output is buffered during the (sync) parse and printed with `Console.log` / `Console.error` after it (commander text ends with `\n`: strip one trailing newline, `Console.log` adds it back, bytes identical).
- Tests capture output with `makeTestConsole` + `Effect.withConsole`; they assert stdout/stderr separately.

### Metrics and the end-of-run summary

- **Own `Metrics` service, not `effect/Metric`.** `Metric` state lives in a process-global registry: no per-run totals (bench rounds, many test runs per process), no reset, and it cannot print main's exact summary text. A `Ref` of counters + phases is ~40 lines and testable with `TestClock`.
- Counters/phases/labels are main's `METRICS` and phase names. `formatRunMetrics` is moved verbatim. Time from `Clock`, so `run.test` style tests use `TestClock.adjust`.
- Octokit request counting: `octokit.hook.before("request", () => Effect.runSync(metrics.increment("githubApiRequests")))`.
- `githubCacheHits`: the cached-call helper checks `cache.contains(key)` before `cache.get(key)` and increments on a hit (concurrent callers sharing an in-flight lookup count as hits, like main).

### Caching and dedup

- **`Cache.makeWith`** for GitHub calls (5 caches: repo, user, content, ref names, file text) and for page fetches (`PageCache`). Lookup in flight is shared by concurrent callers (main's shared promise). `timeToLive: (exit) => success or notFound failure ? Duration.infinity : Duration.zero` reproduces `cacheError: isNotFoundApiError`: only "not found" failures are cached.
- The lookup must not be interrupted by one caller: GitHub timeouts are applied per request inside the lookup (a failure shared by waiters), not around the whole link check (an interrupt of the lookup owner would be seen by the waiters). Main's `TASK_TIMEOUT` around `checkLinkWithGithubApi` becomes the per-request timeout in `GitHub` (same limit, same message).
- `Effect.cachedFunction` replaces `Map` bookkeeping: per-host state in `HostLimiter`, markdown anchors per file in `local_files.ts` (`anchorsOf`). Lazy HTML parsing (`lazyAnchorIndex`) stays as is.
- **No `Request` / `RequestResolver`.** No batching to do (GitHub REST has no batch endpoint, one GraphQL query per discussion), `Effect.request` caches failures indiscriminately (we must not cache rate limits/5xx), and we need the hit count. `Cache` covers dedup and expiry.

### Retries

- Retry logic of one HTTP request stays an explicit loop inside `fetchLimited` (state: current URL, redirects, rate-limit retries, server-error retries; limits 10, 2, 2 as main). **No `Schedule` / `Effect.retry` here** because the host pause must be set _inside_ the slot, before it is released, with a delay that depends on the attempt number. A schedule computes the delay after the slot is gone, which opens the race main's test "pauses the host before releasing the slot" guards against. The planning rules are pure functions (`parseRetryAfter`, `planServerErrorRetry`) shared with Playwright.
- 429: with a usable `Retry-After` (< `TASK_TIMEOUT`), log `Rate limited (...)`, `HostLimiter.pause`, return from the slot, retry (max 2). Otherwise return the 429 response.
- 502/503/504: `planServerErrorRetry` (backoff 2s then 5s, never less than `Retry-After`, capped 10s, give up if `Retry-After` > 10s), pause the host in the slot, retry (max 2), then `serverErrorResult`. Playwright navigations use the same function (pause the final URL's host, close the page, `waitUntilResumed`, navigate again).
- Redirects: manual (`redirect: "manual"`), every hop is its own `withSlot` for the hop's host, max 10, `TooManyRedirects`.
- Where `Schedule`/`Effect.retry` do pay: `Schedule.spaced("30 seconds")` for the progress log in `processAll`, `Effect.retry({ times: 1, while: isBrowserCrashed })` for the browser relaunch.
- Octokit keeps `@octokit/plugin-retry` + `plugin-throttling` (secondary rate limit handling is not worth re-implementing; replacing Octokit by `HttpClient` + `Schema` would remove 4 packages but add ~150 lines and change retry semantics).

### Timeouts and cancellation

- Fetch: `Effect.tryPromise({ try: (signal) => fetch(..., { signal }) })` so interruption aborts the request; `Effect.timeoutFail` per hop inside the slot (covers headers and body read, like `AbortSignal.timeout`), failing with `FetchError` whose cause is `DOMException("The operation was aborted due to timeout", "TimeoutError")` so report texts stay identical. `TestClock` controls it.
- GitHub: `Effect.timeoutFail` (80s, `GitHubTimeout`) + Octokit `request: { signal }` per call.
- Playwright: page operations keep Playwright's own timeouts (30s navigation, 3s/15s hash waits); `withTimeout` helpers become `Effect.timeout` (`readResponseText`) / `Effect.timeoutFail` (setting the hash). Deadlines use `Clock.currentTimeMillis`. Context close in the page scope cancels hung page calls.
- SIGINT/SIGTERM: `runCli` passes an `AbortSignal` to `Effect.runPromise`; interruption runs the finalizers (browser closed, metrics logged) and returns exit code 130. Small addition, nothing changes for runs that are not interrupted.

### Concurrency

- Per host: `HostLimiter` = one `Effect.makeSemaphore(hostConcurrency)` per hostname (created through `Effect.cachedFunction`) + `pausedUntil` `Ref`. Interruptible waiting, waiters are woken in order. **Not strictly FIFO:** Effect's semaphore wakes waiters as a scheduled task, so a fiber that releases and immediately takes again (retry after 429/5xx) gets the slot before the queued ones. Harmless: queued requests wait for the same host pause anyway (tested in `http.test.ts`).
- Pipeline: `processAll` = `Effect.forEach` with `{ concurrency }` (100 for links, 20 for org READMEs, 5 for Playwright page groups), `interleaveByHost` order kept so the pool is not filled by one host.
- Playwright pages: `Effect.makeSemaphore(5)` in `Browser`; retry on crash happens inside the permit (like main).
- GitHub API: no extra limiter, the throttling plugin of Octokit queues requests (same as main).
- **No `Stream`**: results are needed as a whole (grouping by page, report), nothing to stream, `Effect.forEach` is enough.

### Browser lifecycle

- **`RcRef`** (`acquire` = launch Chromium with `Effect.acquireRelease`, `idleTimeToLive: Duration.infinity`) inside `Layer.scoped`: lazy first launch (no browser when no re-check is needed, so the Action still installs Chromium only when needed), concurrent callers share one launch, a failed launch is not cached (next call retries), closed when the run layer closes. A crashed browser: `RcRef.invalidate` closes it, `Effect.retry({ times: 1, while: BrowserCrashed })` relaunches.
- Missing executable: `launch` fails with "Executable doesn't exist" -> `Effect.try(spawnSync(process.execPath, [playwrightCli, "install", "chromium"], { stdio: "inherit" }))`, log `Playwright Chromium is missing, installing...`, launch again, count `browserLaunches` for each launch.
- Page = `Effect.acquireRelease(browser.newContext(...), ctx.close())` + route handler blocking resources + `setDefaultTimeout`. Blocking rules (`shouldBlockRequest`...) copied unchanged.

### Check pipeline

- `checkLinks`: unique hrefs -> `interleaveByHost` -> `processAll` first pass (fetch with `PageCache`, GitHub API, invalid) -> pure `shouldRecheckWithPlaywright` partition -> `groupHrefsByPage` -> `processAll` Playwright (concurrency 5). Results are values returned by `processAll` and merged in a `Map`, not pushed into shared arrays. Errors of a check (`GitHubTimeout`, browser errors, defects) become `unexpected error` results with `getErrorMessage`, no re-check (as main).
- Phases: `Check links (fetch, GitHub API)`, `Re-check links with Playwright`, `Read sitemap`, `Extract links`, `List README files`; same log lines as main.
- Domain logic (hash matching, GitHub URL parsing, markdown, report rendering, baseline matching, selectors) is copied unchanged.

### CLI

- **Keep `commander`, no `@effect/cli`.** Probed with `@effect/cli@0.77.2` against main's behavior:
  - `files a.md --include x` is accepted (`--include` swallowed as a glob), main rejects with `unknown option '--include'` (exit 2).
  - Usage errors exit 1 and print tagged-JSON dumps (`Error: {"_tag":"InvalidValue",...}`), need custom handling of every `ValidationError` to get exit 2 and main's messages.
  - Adds `--completions`, `--log-level`, `--wizard`, `--version` to every command (new user-visible options), plus 5 packages (`printer`, `printer-ansi`, `typeclass`, `ini/toml/yaml`) and `FileSystem|Path|Terminal` requirements.
  - Writing the custom handling is more code than commander's configuration, and main's `cli.test.ts` matrix (`unknown command 'nope'`, `too many arguments`, ...) is commander wording.
- Commander does parsing only (sync, `exitOverride`, `configureOutput` buffers): flags have no env defaults (`--fail-on-broken` / `--no-fail-on-broken` stay `undefined` when absent). The action callback only stores the parsed command. Everything else is one Effect: `resolveOptions` (flags over `EnvOptions`, `UsageError` -> prints `Error: <message>\nRun "docs-link-checker --help" for usage.\n`, exit 2), `loadBaseline` (`BaselineError` -> `Error: <message>`, exit 2), dry-run, run (`runLayer`), annotations, job summary, outputs, baseline update, JSON, `getExitCode` (with the same warn/error log lines).
- Any other failure or defect: `Error: ${error.stack ?? error.message}` on stderr, exit 1 (as main).
- `runCliEffect` returns the exit code and is tested with `@effect/vitest`; `runCli` is the only `Effect.runPromise` of the app (plus `runLive` for scripts).

### Action

- `action.yml` and `docs/action.md` are unchanged: the composite action calls the same CLI with the same flags and reads `GITHUB_OUTPUT`. Job summary, annotations, outputs and blob base URL stay in `github_actions.ts` (pure rendering, writes through `FileSystem`, env through `ActionsEnvConfig`). The self-test workflow is the parity check for this part.

### Schema

- **`Schema` for the baseline file** (replaces `zod`): `Schema.parseJson` of a union (bare array | `{ $schema?, ignore }`), entry = string shorthand | struct with `onExcessProperty: "error"`, one-of `href`/`pattern` refinement, `minLength(1)`, `maxLength(2048)`, custom message for `regex`. Error text = `<path>: <message>` with paths like `ignore[1].href`, exit code 2. **Known deviation:** generic type-mismatch wording differs (Effect: `Expected string, actual 1`; zod: `expected string, received number`). Path, the two custom messages (`expected exactly one of "href" or "pattern"`, `"regex" is not supported ...`) and the length messages are kept. The `baseline.test.ts` expectations change accordingly. If exact wording matters, keep `zod` for this one file and drop this bullet.
- `Schema` for bench's round file (replaces `isRound` guard).
- **Not used** for GitHub responses (Octokit types + `Pick` shapes in `GitHubApi`), HTML, sitemap XML, report JSON (plain objects keep the report format byte-identical).

### Platform

- **`FileSystem` (`@effect/platform`)**: all file I/O (baseline, reports, summary/outputs append, local file checks, `.env`) is interruptible, has typed `PlatformError`, and goes through an injectable service. `stat` follows symlinks, so `findReadme` no longer needs Dirent flags.
- **No `Path` service**: pure functions, `node:path` stays (a service would only add an `R` to pure helpers).
- **No `HttpClient`**: needs per-hop slots with the body read inside the slot, manual redirects and deterministic body cancel. `HttpClient.followRedirects` loops inside one call (one slot for all hops unless the limiter is a client transform that cannot know whether to read the body), and unread bodies are cancelled by a `FinalizationRegistry` / 5s timer, not at slot release. A 60-line `fetchLimited` over the `Fetch` tag is simpler and has the same faking story.

### Tests

- **`@effect/vitest`** (`it.effect`, `it.scoped`, `it.live`, `layer`): `it.effect` gives `TestClock` (no `vi.useFakeTimers`), `it.live` for real FS/network (integration tests keep `*.integration.test.ts` and the separate config).
- No `vi.mock` of own modules and no `vi.stubGlobal("fetch")`: fake leaves through layers: `fakeFetch` (HTTP and Octokit, both use the `Fetch` tag), `fakeGitHub` (check logic), `fakeChromium` (replaces `vi.mock("playwright")`), `makeTestConsole` (stdout/stderr), `ConfigProvider.fromMap` (env), real temp dirs for `FileSystem` (fixtures in `src/__fixtures__` stay).
- Time-dependent tests: fork, `TestClock.adjust`, join (`runWithClock`).
- Test the same behaviors main tests (keep the list of cases, port them), not internals (CODING_STANDARDS). `github_client.test.ts` runs the real `GitHub.layer` over `fakeFetch` (request counting, caching incl. only-not-found, missing token, timeout).
- `vitest.config.js`: add `src/test/**` to coverage excludes; thresholds (93/88/93/93) stay.
- `.oxlintrc.jsonc` (done in STEP 1): the "Convention" rules are errors in `src/**`; `src/test/**`, `bin`, `bench`, `checks` and all `*.test.ts` are exempt (tests need real `setTimeout`, `node:fs` temp dirs). `local_files.ts` disables `no-restricted-imports` for its one `node:fs/promises` `glob` call. `vitest/no-standalone-expect` knows `it.effect|live|scoped|scopedLive`.

## 4. Work plan

Branches `effect-rewrite/<group>` from `effect-rewrite`; one `git worktree` per group (`git worktree add ../dlc-<group> -b effect-rewrite/<group> effect-rewrite`). Each agent runs `pnpm install`, `pnpm tsc`, its own tests, `oxfmt`, `oxlint` on its files. `pnpm knip` and coverage only in STEP 3 (stubs are unused exports until then).

### STEP 1: FOUNDATION (one agent, blocks the rest)

Branch from `9f89352`, then (done, see "STEP 1 notes" below):

1. `package.json`, lockfile, pnpm rules (1), `tsconfig` (unchanged unless needed), `vitest.config.js` coverage exclude, oxlint rules from 3 ("Convention").
2. Write: `errors.ts`, `config.ts`, `logger.ts`, `metrics.ts`, `limiter.ts`, `http.ts`, `utils.ts`, `app.ts`; copy unchanged: `types.ts`, `hash.ts`, `line_anchor.ts`, `markdown.ts`, `glob.ts`, `github/gh_url.ts` + their tests (these use only `console.*`-free code).
3. Test utilities `src/test/{fake_fetch,fake_github,test_console,layers,clock}.ts`.
4. Tests (port from main): `limiter` (pause before release, FIFO, invalid URL), `http` (redirect hops each take a slot, 429 Retry-After pause, 502/503/504 backoff and give-up, timeouts, cancel of unread body, too many redirects; with `TestClock`), `metrics` (summary text, phases, logs on failure), `utils` (processAll order/errors/defects, sampleItems), `config` (parsers, `.env` precedence), `logger` (stream split, json mode).
5. **Stubs of every cross-group interface** so each group compiles alone: create each file listed in 2.2 to 2.5 with the exact exported signatures of section 2 and bodies `Effect.die("not implemented")` (pure functions that main already has may be copied as is). `GitHub` tag/types in `github_client.ts` are final (only `layer` is a stub), `Browser`/`Chromium` tags in `browser.ts` likewise, `Metrics`/`HostLimiter`/`Fetch` real. `cli.ts` stub exports `runCliEffect`/`runCli`.
6. Exit criteria: `pnpm tsc` green, foundation tests green, `liveRunLayer` builds (a trivial test builds it with fakes and runs `checkLinks` stub). Merge to `effect-rewrite`.

Rule for groups: do not edit files you do not own. A needed change in a foundation file or another group's contract: write the workaround locally and note it in the PR description, resolved in STEP 3.

### STEP 2: parallel groups (after STEP 1 is merged)

| Group    | Owns (files + their tests)                                                                                                        | Needs from others (via stubs/real foundation)                                                                                                                                                | Delivers                                                                 |
| -------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| GITHUB   | `src/github/{github_client,gh_api,gh_check_link,gh_get_links}.ts`, `src/github/checks/*`, tests incl. `*.integration.test.ts`     | `Fetch`, `Metrics`, `HostLimiter`, `fetchLimited` (real); `checkLinks` (stub, used by `checkReadmesInGithubOrg`); `checkLinkWithFetch` (stub)                                                | `GitHub.layer`, all checks, org README flow                              |
| BROWSER  | `src/browser.ts`, `src/playwright_check.ts`, `src/test/fake_chromium.ts`, tests                                                   | `Metrics`, `HostLimiter`, `planServerErrorRetry`, `classifyStatus` (real)                                                                                                                    | `Chromium`, `Browser`, `checkUrlsOnPageWithPlaywright`                   |
| PIPELINE | `src/fetch_check.ts`, `link.ts`, `page.ts`, `sitemap.ts`, `website.ts`, `local_files.ts`, tests incl. `link.integration.test.ts`  | `fetchLimited`, `processAll` (real); `checkLinkWithGithubApi`, `checkUrlsOnPageWithPlaywright`, `Browser` (stubs; tests fake `GitHub`/`Browser` with `fakeGitHub` / a dying-`Browser` layer) | `checkLinks`, `checkWebsite`, `checkLocalFiles`, `collectLinksFromFiles` |
| CLI      | `src/cli.ts`, `baseline.ts`, `report/report.tsx`, `github_actions.ts`, `bin/`, `bench/bench.ts`, `checks/gh_rate_limit.ts`, tests | `checkWebsite`, `checkLocalFiles`, `collectLinksFromFiles`, `checkReadmesInGithubOrg` (stubs), `testRunLayer`                                                                                | `runCliEffect`, `runCli`, baseline Schema, report/summary writes         |

Test split of main's `link.test.ts` (1012 lines): fetch/PageCache/status/429/redirect cases -> PIPELINE (`fetch_check.test.ts`, `link.test.ts` with a dying `Browser`), Playwright hash/deadline/retry/page-crash cases -> BROWSER (`playwright_check.test.ts`). Combined fetch-fails-then-Playwright-passes tests are added in STEP 3.
CLI tests run end to end with `runCliEffect` + `testRunLayer({ fetch, github })`, real temp dirs, `makeTestConsole`; port the matrix of main's `cli.test.ts` (usage errors, env defaults, baseline cases, `--json`, `--dry-run`, annotations, exit codes).

### STEP 3: integration, review, parity (one agent, then user review)

1. Merge the four branches, fix contract mismatches, add the combined Playwright/pipeline tests, delete leftover stubs, remove `EFFECT_NOTES.md` of the port (replace by short notes in module overviews).
2. `pnpm check` (format, lint, tsc, knip), `pnpm test:coverage` (thresholds), `pnpm test:integration` (needs `GH_TOKEN`).
3. Review against CODING_STANDARDS.md: deep modules, no thin wrappers, no leaked internals, comments with WHY and doc links, tests not coupled to internals, no tautologies.
4. CLI parity vs main, with a `git worktree` of `9f89352` (`pnpm install` there), same inputs on both, normalized diff of stdout, stderr, exit code and written files:
   - usage matrix: every row of main's `cli.test.ts` `it.each` (exit code 2, message), `--help`, `help site`, no args;
   - `files` on `src/__fixtures__/local` and `test/action-fixture` with/without baseline, `--dry-run`, `--json` (stdout parses and equals main's), `--no-annotations`, `--update-baseline [--prune-baseline]`, with `GITHUB_ACTIONS=true GITHUB_OUTPUT=.. GITHUB_STEP_SUMMARY=.. GITHUB_WORKSPACE/SHA/REPOSITORY`: compare `results/*.json`, `*.html`, summary and output files byte for byte;
   - `site` against a local HTTP fixture server (sitemap index, redirect chain, 429 with `Retry-After`, 503 then 200, 404, hash on SSR page, client-rendered hash) and `github-org` with a fake API (env `GH_TOKEN`) or the real one;
   - `pnpm bench --base <main worktree>`: "Changed results" must be empty, total time not worse, same counters;
   - `.github/workflows/action-selftest.yaml` on the branch;
   - differences allowed: help text layout, timing numbers, the baseline Schema wording (3 "Schema"), exit code 130 on SIGINT.

## 5. Expected effect on size

Non-test lines of `src/` (+ nothing else changes). Main 5205, port 5536 (the port added 6%).

| Area                                                                             | Main     | Port     | Target    | Why                                                                                                                                                       |
| -------------------------------------------------------------------------------- | -------- | -------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| core (run, limiter, http, utils, errors, tryCatch, metrics, config, logger, app) | 726      | 938      | ~600      | `runCached`/context/ALS gone, `p-limit`, `withTimeout`, `tryCatch` gone, `Config` and logger layer are new (~90) but env parsing leaves limiter/utils/cli |
| browser + playwright_check                                                       | 537      | 484      | ~400      | `RcRef` replaces slot/launch/forget code, semaphore, `Effect.timeout`                                                                                     |
| fetch pipeline (fetch_check, link, page, sitemap, website)                       | 683      | 698      | ~560      | `Cache` replaces `PageFetchCache`, `processAll` returns values instead of shared arrays                                                                   |
| local_files                                                                      | 307      | 333      | ~300      | `FileSystem` effects ~ sync code, `stat` follows symlinks, `cachedFunction` for anchors                                                                   |
| github (client, api, checks, check_link, get_links)                              | 868      | 934      | ~865      | typed client with caches (+170) offsets removed `tryCatch`, WeakMaps, plumbing                                                                            |
| baseline + github_actions                                                        | 427      | 484      | ~390      | `Schema` ~ zod, `ActionsEnv` replaces env record plumbing                                                                                                 |
| cli                                                                              | 541      | 549      | ~400      | no env/io plumbing, no console swap, flat Effect flow, commander setup (~200) stays                                                                       |
| report                                                                           | 547      | 547      | ~540      | pure rendering unchanged                                                                                                                                  |
| unchanged domain (glob, hash, line_anchor, markdown, gh_url, types)              | 569      | 569      | 569       |                                                                                                                                                           |
| **Total**                                                                        | **5205** | **5536** | **~4600** | -11% vs main, -16% vs port (uncertainty +-10%)                                                                                                            |

- Tests: main 5990, port 6482, target ~5400 plus ~300 of `src/test/` utilities: no `vi.hoisted` module mocks and manual fake timers, but more `layer` setup per file.
- Dependencies: 3 added (`@effect/platform`, `@effect/platform-node-shared`, dev `@effect/vitest`), 2 removed (`p-limit`, `zod`), `effect` already there.
- Does not pay off, so not used: `@effect/cli`, `HttpClient`, `Path`, `effect/Metric`, `Request`/`RequestResolver`, `Stream`, `Schedule` for the HTTP retry loop, `Effect.Service`, tracing/spans.

### STEP 1 notes (for the STEP 2 groups)

- Main's code of every stubbed file is `git show 9f89352:<path>` (same for main's tests). `src/limiter.test.ts`, `http.test.ts`, `utils.test.ts` were rewritten, `run.ts`, `utils/errors.ts`, `utils/tryCatch.ts` deleted (`getErrorMessage` is in `errors.ts`).
- Stubs: bodies are `Effect.die("not implemented")` (`runCli` rejects, `Browser.layer` / `GitHub.layer` build fine and die on use). Pure functions of main are real. Real, not stubs: `Chromium` (the one `chromium.launch` call), `tryPlaywright`, `getApiErrorResult`, `getGithubBlobBaseUrl`, `createBaseline`, `updateBaseline`.
- Tests of stubbed modules are skeleton files: main's `describe` / test titles as `it.todo` (cannot be `it.skip`: the old bodies do not type check against the new signatures). A group replaces the `it.todo` lines of its files with real tests. `vitest/warn-todo` is off in `.oxlintrc.jsonc` until the last skeleton is gone. Files with real tests and `it.todo` blocks mixed: `baseline.test.ts`, `github_actions.test.ts`, `github/gh_get_links.test.ts`, `link.test.ts`, `page.test.ts`.
- `knip.jsonc` (was `knip.json`, needs comments) ignores the stub files, the exports only STEP 2 uses and the dependencies only STEP 2 uses (`commander`, `@octokit/*`, `@effect/platform-node-shared`). STEP 3 deletes those entries.
- `bench/bench.ts` and `checks/gh_rate_limit.ts` were adapted minimally (`runLive`, `Metrics.snapshot`, `GitHub.getRateLimit`). `pnpm bench --base <main worktree>` copies `bench.ts` into the base checkout, where `../src/app` does not exist: the CLI group must make the round script work against main (e.g. a main-compatible fallback) or STEP 3 compares in another way.

### STEP 2 notes

- BROWSER: `BrowserLaunchError` got a `message` getter (`getErrorMessage(cause)`, like `PlaywrightError`): the pipeline reports `error.message` as `errorDetail` ("Failed to launch ...").
- BROWSER: `BrowserCrashed` is not used. `withPage` keeps the crash as a flag of one attempt and surfaces the original error of the second attempt without a cast.
- BROWSER: `src/test/fake_chromium.ts` exports `makeFakeChromiumState()` (mutable state object a test sets and reads) next to `fakeChromium(state)`. Its waits use the Effect clock of the test that builds the layer, so build it inside `it.effect`.

#### CLI group (cli, baseline, github_actions, report, bench)

- No contract signature changed. `runCli` / `runCliEffect` / `saveReport` / `writeJobSummary` / `writeGithubOutputs` / `loadBaseline` / `writeBaseline` are as in 2.5.
- `cli.test.ts` fakes the check functions (`checkLocalFiles`, `collectLinksFromFiles`, `checkWebsite`, `checkReadmesInGithubOrg`) with `vi.mock`: they are plain functions, not services, so a layer cannot replace them. It tests what the CLI passes to them and does with their results. STEP 3: add end to end cases over the real pipeline (`files` on `src/__fixtures__/local`, `site` over `fakeFetch`), then the mocks can go.
- Baseline Schema wording: generic type mismatches are Effect's (`ignore[0].href: Expected string, actual 1`), excess keys are `ignore[1].herf: is unexpected, expected: ...`. Own messages: empty (`expected a non-empty string`), too long (`expected at most 2048 characters`), `expected exactly one of "href" or "pattern"` (path `ignore[0]`). The `"regex" is not supported ...` message has the path `ignore[0].regex` (main: `ignore[0]`).
- `bench/round.ts` is new: one round, only Node built-ins and dynamic imports of `../src`, so it runs inside a main checkout (`pnpm bench --base <dir>` copies it to `<dir>/.bench/`). It picks the Effect API (`src/app.ts`) or main's `src/run.ts` API. Remove `runLegacy` once main has the Effect version. `bench.ts` only drives the rounds and validates the round files with `Schema`.
- Dropped test: "never falls back to the real GITHUB_STEP_SUMMARY / GITHUB_OUTPUT": the writers have no env fallback anymore (the file comes from `ActionsEnv` via `Config`, tests use `ConfigProvider.fromMap`). New cases: `saveReport`, multi-line output value dies and writes nothing, unreadable baseline file, `--host-concurrency` reaches the run layer, usage error output format, `--dry-run --json`, `runCli` smoke test.
- `knip.jsonc`: the `src/website.ts` ignore entry can go now (the CLI imports it), left to the PIPELINE group to avoid a merge conflict.
