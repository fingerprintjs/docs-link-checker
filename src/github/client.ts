import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import { getDeps, getTerminal, incrementMetric, runCached } from "../run";

/**
 * The GitHub API client and the one path every request of a run goes through (`githubRequest`).
 * - `GithubApi` lists the Octokit methods the app uses, with only the response fields it reads. The real client must
 *   match it (checked by tsc), tests inject a typed fake through the run (see `RunDeps.octokit`).
 * - Requests are cached for the run and can be aborted (see `runCached`).
 * Octokit REST docs: https://octokit.github.io/rest.js/
 */

const MyOctokit = Octokit.plugin(retry, throttling);

type MyOctokitInstance = InstanceType<typeof MyOctokit>;
type ThrottleOptions = NonNullable<
  NonNullable<ConstructorParameters<typeof MyOctokit>[0]>["throttle"]
>;
type LimitHandler = NonNullable<ThrottleOptions["onRateLimit"]>;

type WithSignal = { request?: { signal?: AbortSignal } };
type Response<T> = Promise<{ data: T }>;
type RepoParams = { owner: string; repo: string } & WithSignal;

/** An entry of the contents API: a file, or a directory listing (array) */
type ContentEntry = {
  type: string;
  sha: string;
  size?: number;
  /** Base64, empty for files over 1 MB (`encoding: "none"`). Missing for symlinks and submodules. */
  content?: string;
  encoding?: string;
};

/** The Octokit methods used by the app, see the module comment */
export type GithubApi = {
  users: { getByUsername: (params: { username: string } & WithSignal) => Response<unknown> };
  repos: {
    get: (params: RepoParams) => Response<{ default_branch: string }>;
    getContent: (
      params: RepoParams & { ref: string; path: string },
    ) => Response<ContentEntry | ContentEntry[]>;
    getCommit: (params: RepoParams & { ref: string }) => Response<unknown>;
    getRelease: (params: RepoParams & { release_id: number }) => Response<unknown>;
    getReleaseByTag: (
      params: RepoParams & { tag: string },
    ) => Response<{ assets: { name: string }[] }>;
    getLatestRelease: (params: RepoParams) => Response<unknown>;
    listReleases: (params: RepoParams & { per_page: number }) => Response<unknown[]>;
    listForOrg: (
      params: { org: string; type: "public"; per_page: number } & WithSignal,
    ) => Response<
      { name: string; full_name: string; archived?: boolean; owner: { login: string } }[]
    >;
  };
  issues: { get: (params: RepoParams & { issue_number: number }) => Response<unknown> };
  pulls: { get: (params: RepoParams & { pull_number: number }) => Response<unknown> };
  git: {
    getBlob: (params: RepoParams & { file_sha: string }) => Response<{ content: string }>;
    listMatchingRefs: (params: RepoParams & { ref: string }) => Response<{ ref: string }[]>;
    getTree: (
      params: RepoParams & { tree_sha: string; recursive: "1" },
    ) => Response<{ tree: { type: string; path: string }[] }>;
  };
  graphql: (query: string, variables: Record<string, unknown> & WithSignal) => Promise<unknown>;
  /** All pages of a list endpoint */
  paginate: <P, T>(route: (params: P) => Response<T[]>, params: P) => Promise<T[]>;
};

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

/**
 * A new Octokit client with retries and rate limit handling, authenticated with `GH_TOKEN`
 * @throws {Error} if `GH_TOKEN` is not set
 */
export const createOctokit = (): MyOctokitInstance => {
  const token = process.env.GH_TOKEN;
  if (!token) {
    throw new Error("GH_TOKEN is not set. A GitHub token is required to check GitHub links.");
  }
  // Resolved per request: the client is shared by all runs, the injected fetch belongs to a run
  const fetchOfRun: typeof fetch = (...args) => (getDeps().fetch ?? fetch)(...args);
  const octokit = new MyOctokit({
    auth: token,
    throttle: throttleOptions,
    // The default logs every request (`GET /repos/... - 200 with id ...`) as info, failed ones as error.
    // Both are shown with --verbose only: callers handle failed requests (a 401 falls back to the browser).
    log: {
      debug: () => {},
      info: (message: string) => getTerminal().verbose(message),
      // Rate limit warnings stay visible, through the terminal so they don't break the progress line
      warn: (message: string) => getTerminal().line(message),
      error: (message: string) => getTerminal().verbose(message),
    },
    request: { fetch: fetchOfRun },
  });
  // Counts every request (all operations, pagination pages, GraphQL, retries of the plugins) in one place
  octokit.hook.before("request", () => {
    incrementMetric("githubApiRequests");
  });
  return octokit;
};

let client: GithubApi | undefined;

/**
 * The client injected in the run, or the shared one. The shared client is created on first use, so importing modules
 * that use it does not require `GH_TOKEN` (e.g. in offline unit tests).
 * @throws {Error} if `GH_TOKEN` is not set
 */
export const getGithubApi = (): GithubApi => {
  const injected = getDeps().octokit;
  if (injected) {
    return injected();
  }
  client ??= createOctokit();
  return client;
};

/** HTTP status of a failed GitHub API request, `undefined` without a response (network error, no `GH_TOKEN`) */
export const getApiErrorStatus = (error: unknown): number | undefined =>
  typeof error === "object" &&
  error !== null &&
  "status" in error &&
  typeof error.status === "number"
    ? error.status
    : undefined;

/**
 * `true` if a failed GitHub API request is a definitive "missing" answer: 404 Not Found or 410 Gone (deleted issues).
 * Nothing else proves a link is broken: 401 (bad token), 403 (rate limits surface as 403 after Octokit's retry, or no
 * access), 429, 5xx and network errors say nothing about the link.
 */
export const isNotFoundApiError = (error: unknown): boolean => {
  const status = getApiErrorStatus(error);
  return status === 404 || status === 410;
};

// GitHub names are case-insensitive, refs, paths and tags are not
const CASE_INSENSITIVE_PARAMS = new Set(["owner", "repo", "username", "org"]);

/**
 * Sends a GitHub API request once per run for the same `name` and `params` (many README links point to the same
 * repositories and files), see `runCached` for aborts.
 * @param name the operation, part of the cache key with `params`
 * @param params sent to `call` with the signal of the shared request
 * @param isMissing a definitive "missing" answer, cached like a response. Other errors (rate limits, 401/403, 5xx) are
 *   retried on the next call.
 */
export const githubRequest = <P extends Record<string, string | number>, T>(
  name: string,
  params: P,
  call: (api: GithubApi, params: P & WithSignal) => Promise<T>,
  {
    signal,
    isMissing = isNotFoundApiError,
  }: { signal?: AbortSignal; isMissing?: (error: unknown) => boolean } = {},
): Promise<T> => {
  const keyParams = Object.fromEntries(
    Object.entries(params).map(([param, value]) => [
      param,
      CASE_INSENSITIVE_PARAMS.has(param) && typeof value === "string" ? value.toLowerCase() : value,
    ]),
  );
  return runCached(
    `github:${name}:${JSON.stringify(keyParams)}`,
    // `async`: a client that can't be created (no `GH_TOKEN`) rejects instead of throwing
    async (sharedSignal) => call(getGithubApi(), { ...params, request: { signal: sharedSignal } }),
    // Requests themselves are counted by the Octokit client (see `createOctokit`)
    { signal, cacheError: isMissing, onHit: () => incrementMetric("githubCacheHits") },
  );
};

/** `GET /repos/{owner}/{repo}`, shared by the repository links and the README listing of an organization */
export const getRepo = (owner: string, repo: string, signal?: AbortSignal) =>
  githubRequest("repo", { owner, repo }, (api, params) => api.repos.get(params), { signal });
