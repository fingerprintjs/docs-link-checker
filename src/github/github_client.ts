/**
 * GitHub API as one service: typed methods (Octokit inside), caches per run, request metrics, timeouts.
 * - `GitHubApi` exposes only the fields the checks read, so test fakes stay small.
 * - Many README links point to the same repositories and files, so repos, users, contents, ref listings and file
 *   texts are cached for the run. Concurrent calls share one request. Only "not found" failures are cached:
 *   rate limits, 401/403 and 5xx say nothing about the resource and are asked again.
 * - The Octokit client is created on first use, so building the layer does not need `GH_TOKEN`.
 * - Octokit keeps its retry and throttling plugins (secondary rate limits).
 */
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import {
  Cache,
  Cause,
  Context,
  Data,
  Duration,
  Effect,
  Either,
  Equal,
  Exit,
  Hash,
  Layer,
  Option,
  Redacted,
} from "effect";
import { GithubToken } from "../config";
import { GitHubApiError, GitHubTimeout } from "../errors";
import { Fetch, TASK_TIMEOUT } from "../http";
import { getMarkdownAnchors } from "../markdown";
import { Metrics } from "../metrics";

export type RepoInfo = { readonly default_branch: string };
export type FileInfo = {
  readonly content: string;
  readonly encoding?: string;
  readonly sha: string;
  readonly size?: number;
};
/** A file, or a directory listing / symlink / submodule */
export type ContentInfo = FileInfo | { readonly content?: undefined };
export type ReleaseInfo = { readonly assets: ReadonlyArray<{ readonly name: string }> };
export type OrgRepo = {
  readonly full_name: string;
  readonly name: string;
  readonly archived?: boolean;
  readonly owner: { readonly login: string };
};
export type TreeEntry = { readonly type?: string; readonly path?: string };
/** Anchors are parsed once, lazily */
export type FileText = {
  readonly text: string;
  readonly binary: boolean;
  readonly getAnchors: () => Set<string>;
};
export type GitHubError = GitHubApiError | GitHubTimeout;

export type GitHubApi = {
  /** Cached (lowercase key) */
  readonly getRepo: (owner: string, repo: string) => Effect.Effect<RepoInfo, GitHubError>;
  /** User or organization, cached */
  readonly getUser: (username: string) => Effect.Effect<void, GitHubError>;
  readonly getCommit: (
    owner: string,
    repo: string,
    ref: string,
  ) => Effect.Effect<void, GitHubError>;
  readonly getPullRequest: (
    owner: string,
    repo: string,
    number: number,
  ) => Effect.Effect<void, GitHubError>;
  readonly getIssue: (
    owner: string,
    repo: string,
    number: number,
  ) => Effect.Effect<void, GitHubError>;
  /** GraphQL NOT_FOUND is a `GitHubApiError` with status 404 */
  readonly getDiscussion: (
    owner: string,
    repo: string,
    number: number,
  ) => Effect.Effect<void, GitHubError>;
  readonly getReleaseByTag: (
    owner: string,
    repo: string,
    tag: string,
  ) => Effect.Effect<ReleaseInfo, GitHubError>;
  readonly getRelease: (
    owner: string,
    repo: string,
    releaseId: number,
  ) => Effect.Effect<void, GitHubError>;
  readonly hasReleases: (owner: string, repo: string) => Effect.Effect<boolean, GitHubError>;
  /** Cached */
  readonly getContent: (
    owner: string,
    repo: string,
    ref: string,
    path: string,
  ) => Effect.Effect<ContentInfo, GitHubError>;
  /** Matching refs, all pages, names without `refs/<kind>/`, cached */
  readonly listRefNames: (
    owner: string,
    repo: string,
    kind: "heads" | "tags",
    prefix: string,
  ) => Effect.Effect<ReadonlyArray<string>, GitHubError>;
  /** Base64 decode, blobs API for files over 1 MB, cached by sha */
  readonly getFileText: (
    owner: string,
    repo: string,
    file: FileInfo,
  ) => Effect.Effect<FileText, GitHubError>;
  /** Public repos, all pages */
  readonly listOrgRepos: (org: string) => Effect.Effect<ReadonlyArray<OrgRepo>, GitHubError>;
  /** Recursive tree */
  readonly getTreeEntries: (
    owner: string,
    repo: string,
    ref: string,
  ) => Effect.Effect<ReadonlyArray<TreeEntry>, GitHubError>;
  readonly getRateLimit: Effect.Effect<
    { readonly remaining: number; readonly reset: number },
    GitHubError
  >;
};

const MyOctokit = Octokit.plugin(retry, throttling);
type MyOctokitInstance = InstanceType<typeof MyOctokit>;
type ThrottleOptions = NonNullable<
  NonNullable<ConstructorParameters<typeof MyOctokit>[0]>["throttle"]
>;
type LimitHandler = NonNullable<ThrottleOptions["onRateLimit"]>;

/** Retry once on a rate limit (primary or secondary), then give up */
const onRateLimited =
  (kind: string): LimitHandler =>
  (retryAfter, options, octokit, retryCount) => {
    octokit.log.warn(`${kind} for request ${options.method} ${options.url}`);
    if (retryCount < 1) {
      octokit.log.info(`Retrying after ${retryAfter} seconds!`);
      return true;
    }
    return false;
  };

const throttleOptions = {
  onRateLimit: onRateLimited("Request quota exhausted"),
  onSecondaryRateLimit: onRateLimited("SecondaryRateLimit detected"),
} satisfies ThrottleOptions;

const NO_TOKEN_MESSAGE = "GH_TOKEN is not set. A GitHub token is required to check GitHub links.";

/** HTTP status of a failed request, `undefined` without a response (network error, no token) */
const getStatus = (error: unknown): number | undefined =>
  typeof error === "object" &&
  error !== null &&
  "status" in error &&
  typeof error.status === "number"
    ? error.status
    : undefined;

/** GraphQL answers a missing repository or discussion with a NOT_FOUND error in a 200 response */
const isGraphqlNotFound = (error: unknown): boolean => {
  const { errors, message } = (error ?? {}) as {
    errors?: { type?: string }[];
    message?: string;
  };
  return (
    errors?.some((e) => e.type === "NOT_FOUND") === true ||
    /Could not resolve to a (Discussion|Repository)/.test(message ?? "")
  );
};

/** Only "not found" is a definitive answer worth caching */
const isCacheable = (exit: Exit.Exit<unknown, GitHubError>): boolean =>
  Exit.isSuccess(exit) ||
  Option.exists(
    Cause.failureOption(exit.cause),
    (error) => error instanceof GitHubApiError && error.isNotFound,
  );

const makeCache = <Key, Value>(lookup: (key: Key) => Effect.Effect<Value, GitHubError>) =>
  Cache.make({ capacity: Number.MAX_SAFE_INTEGER, timeToLive: Duration.infinity, lookup });

/** Names are case-insensitive: lowercased in cache keys */
type RepoKey = { readonly owner: string; readonly repo: string };
const repoKey = (owner: string, repo: string): RepoKey =>
  Data.struct({ owner: owner.toLowerCase(), repo: repo.toLowerCase() });

/** A blob never changes: equal by sha, the content is only needed by the first lookup */
class FileKey implements Equal.Equal {
  constructor(
    readonly owner: string,
    readonly repo: string,
    readonly file: FileInfo,
  ) {}
  [Hash.symbol](): number {
    return Hash.string(`${this.owner}/${this.repo}/${this.file.sha}`);
  }
  [Equal.symbol](that: Equal.Equal): boolean {
    return (
      that instanceof FileKey &&
      that.owner === this.owner &&
      that.repo === this.repo &&
      that.file.sha === this.file.sha
    );
  }
}

const make = Effect.gen(function* () {
  const fetch = yield* Fetch;
  const metrics = yield* Metrics;
  const token = yield* Effect.orDie(GithubToken);

  const getOctokit: Effect.Effect<MyOctokitInstance, GitHubApiError> = yield* Effect.cached(
    Effect.suspend(() => {
      if (Option.isNone(token)) {
        return Effect.fail(
          new GitHubApiError({ status: undefined, cause: new Error(NO_TOKEN_MESSAGE) }),
        );
      }
      const octokit = new MyOctokit({
        auth: Redacted.value(token.value),
        throttle: throttleOptions,
        request: { fetch },
      });
      // Counts every request: all operations, pages, GraphQL, retries of the plugins
      octokit.hook.before("request", () => {
        Effect.runSync(metrics.increment("githubApiRequests"));
      });
      return Effect.succeed(octokit);
    }),
  );

  /** One API request. Interrupting or timing out aborts it (`signal`) */
  const request = <A>(
    send: (octokit: MyOctokitInstance, signal: AbortSignal) => Promise<A>,
  ): Effect.Effect<A, GitHubError> =>
    Effect.flatMap(getOctokit, (octokit) =>
      Effect.tryPromise({
        try: (signal) => send(octokit, signal),
        catch: (cause) => new GitHubApiError({ status: getStatus(cause), cause }),
      }),
    ).pipe(
      Effect.timeoutFail({
        duration: Duration.millis(TASK_TIMEOUT),
        onTimeout: () =>
          new GitHubTimeout({ message: `GitHub API check timed out after ${TASK_TIMEOUT}ms` }),
      }),
    );

  /**
   * Cache lookup, counts a reused entry (also one that another caller is still fetching) as a hit.
   * Entries are removed when the lookup fails with anything but "not found" (the cache TTL cannot do it: an entry
   * with TTL zero is still valid in the millisecond it was created).
   */
  const cached = <Key, Value>(
    cache: Cache.Cache<Key, Value, GitHubError>,
    key: Key,
  ): Effect.Effect<Value, GitHubError> =>
    Effect.flatMap(cache.getEither(key), (result) =>
      Either.isLeft(result)
        ? Effect.as(metrics.increment("githubCacheHits"), result.left)
        : Effect.succeed(result.right),
    ).pipe(Effect.onExit((exit) => (isCacheable(exit) ? Effect.void : cache.invalidate(key))));

  const repos = yield* makeCache(({ owner, repo }: RepoKey) =>
    request((octokit, signal) => octokit.repos.get({ owner, repo, request: { signal } })).pipe(
      Effect.map(({ data }): RepoInfo => ({ default_branch: data.default_branch })),
    ),
  );
  const users = yield* makeCache((username: string) =>
    Effect.asVoid(
      request((octokit, signal) => octokit.users.getByUsername({ username, request: { signal } })),
    ),
  );
  const contents = yield* makeCache(
    ({ owner, repo, ref, path }: RepoKey & { readonly ref: string; readonly path: string }) =>
      request((octokit, signal) =>
        octokit.repos.getContent({ owner, repo, ref, path, request: { signal } }),
      ).pipe(
        Effect.map(({ data }): ContentInfo => {
          // A directory (array), symlink or submodule has no content
          if (Array.isArray(data) || !("content" in data)) {
            return {};
          }
          return { content: data.content, encoding: data.encoding, sha: data.sha, size: data.size };
        }),
      ),
  );
  const refNames = yield* makeCache(
    ({
      owner,
      repo,
      kind,
      prefix,
    }: RepoKey & { readonly kind: "heads" | "tags"; readonly prefix: string }) =>
      request((octokit, signal) =>
        octokit.paginate(octokit.git.listMatchingRefs, {
          owner,
          repo,
          ref: `${kind}/${prefix}`,
          request: { signal },
        }),
      ).pipe(
        Effect.map((refs) =>
          refs.flatMap(({ ref }) =>
            ref.startsWith(`refs/${kind}/`) ? [ref.slice(`refs/${kind}/`.length)] : [],
          ),
        ),
      ),
  );
  const fileTexts = yield* makeCache(({ owner, repo, file }: FileKey) =>
    Effect.gen(function* () {
      // Files over 1 MB have no content in the contents API (`encoding: "none"`), up to 100 MB with the blobs API
      const isLarge = file.encoding === "none" || (file.content === "" && (file.size ?? 0) > 0);
      const base64 = isLarge
        ? (yield* request((octokit, signal) =>
            octokit.git.getBlob({ owner, repo, file_sha: file.sha, request: { signal } }),
          )).data.content
        : file.content;
      const buffer = Buffer.from(base64, "base64");
      const text = buffer.toString("utf8");
      let anchors: Set<string> | undefined;
      return {
        text,
        // GitHub shows no lines for binary files
        binary: buffer.includes(0),
        getAnchors: () => (anchors ??= getMarkdownAnchors(text)),
      } satisfies FileText;
    }),
  );

  /** Resolves if the request succeeds, the response is not needed */
  const succeeds = <A>(
    send: (octokit: MyOctokitInstance, signal: AbortSignal) => Promise<A>,
  ): Effect.Effect<void, GitHubError> => Effect.asVoid(request(send));

  return {
    getRepo: (owner, repo) => cached(repos, repoKey(owner, repo)),
    getUser: (username) => cached(users, username.toLowerCase()),
    getCommit: (owner, repo, ref) =>
      succeeds((octokit, signal) =>
        octokit.repos.getCommit({ owner, repo, ref, request: { signal } }),
      ),
    getPullRequest: (owner, repo, number) =>
      succeeds((octokit, signal) =>
        octokit.pulls.get({ owner, repo, pull_number: number, request: { signal } }),
      ),
    getIssue: (owner, repo, number) =>
      succeeds((octokit, signal) =>
        octokit.issues.get({ owner, repo, issue_number: number, request: { signal } }),
      ),
    getDiscussion: (owner, repo, number) =>
      succeeds((octokit, signal) =>
        octokit.graphql(
          `query ($owner: String!, $repo: String!, $number: Int!) {
            repository(owner: $owner, name: $repo) {
              discussion(number: $number) {
                id
              }
            }
          }`,
          { owner, repo, number, request: { signal } },
        ),
      ).pipe(
        Effect.catchTag("GitHubApiError", (error) =>
          Effect.fail(
            isGraphqlNotFound(error.cause)
              ? new GitHubApiError({ status: 404, cause: error.cause })
              : error,
          ),
        ),
      ),
    getReleaseByTag: (owner, repo, tag) =>
      request((octokit, signal) =>
        octokit.repos.getReleaseByTag({ owner, repo, tag, request: { signal } }),
      ).pipe(
        Effect.map(({ data }): ReleaseInfo => ({
          assets: data.assets.map(({ name }) => ({ name })),
        })),
      ),
    getRelease: (owner, repo, releaseId) =>
      succeeds((octokit, signal) =>
        octokit.repos.getRelease({ owner, repo, release_id: releaseId, request: { signal } }),
      ),
    hasReleases: (owner, repo) =>
      request((octokit, signal) =>
        octokit.repos.listReleases({ owner, repo, per_page: 1, request: { signal } }),
      ).pipe(Effect.map(({ data }) => data.length > 0)),
    getContent: (owner, repo, ref, path) =>
      cached(contents, Data.struct({ ...repoKey(owner, repo), ref, path })),
    listRefNames: (owner, repo, kind, prefix) =>
      cached(refNames, Data.struct({ ...repoKey(owner, repo), kind, prefix })),
    getFileText: (owner, repo, file) =>
      cached(fileTexts, new FileKey(owner.toLowerCase(), repo.toLowerCase(), file)),
    listOrgRepos: (org) =>
      request((octokit, signal) =>
        octokit.paginate(octokit.repos.listForOrg, {
          org,
          type: "public",
          per_page: 100,
          request: { signal },
        }),
      ).pipe(
        Effect.map((orgRepos) =>
          orgRepos.map((orgRepo): OrgRepo => ({
            full_name: orgRepo.full_name,
            name: orgRepo.name,
            archived: orgRepo.archived,
            owner: { login: orgRepo.owner.login },
          })),
        ),
      ),
    getTreeEntries: (owner, repo, ref) =>
      request((octokit, signal) =>
        octokit.git.getTree({ owner, repo, tree_sha: ref, recursive: "1", request: { signal } }),
      ).pipe(
        Effect.map(({ data }) =>
          data.tree.map((entry): TreeEntry => ({ type: entry.type, path: entry.path })),
        ),
      ),
    getRateLimit: request((octokit, signal) =>
      octokit.rest.rateLimit.get({ request: { signal } }),
    ).pipe(Effect.map(({ data }) => ({ remaining: data.rate.remaining, reset: data.rate.reset }))),
  } satisfies GitHubApi;
});

export class GitHub extends Context.Tag("GitHub")<GitHub, GitHubApi>() {
  static readonly layer: Layer.Layer<GitHub, never, Fetch | Metrics> = Layer.effect(GitHub, make);
}
