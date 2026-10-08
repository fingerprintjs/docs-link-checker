/**
 * The Octokit client of the run as an Effect service. Requests are Effects that fail with `GitHubApiError`.
 * - https://octokit.github.io/rest.js/
 * - https://effect.website/docs/requirements-management/layers/
 */
import { existsSync } from "node:fs";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import { Context, Data, Effect, Layer } from "effect";
import { Metrics, type RunCache } from "../run";
import { getErrorMessage } from "../utils/errors";

// Optional local .env, existing env vars win (https://nodejs.org/api/process.html#processloadenvfilepath)
if (existsSync(".env")) {
  process.loadEnvFile();
}

const MyOctokit = Octokit.plugin(retry, throttling);

export type MyOctokitInstance = InstanceType<typeof MyOctokit>;
type ThrottleOptions = NonNullable<
  NonNullable<ConstructorParameters<typeof MyOctokit>[0]>["throttle"]
>;
type LimitHandler = NonNullable<ThrottleOptions["onRateLimit"]>;

/**
 * A GitHub API request failed. `status` is the HTTP status of the response, `undefined` without one (network error,
 * no `GH_TOKEN`). `cause` is the original error (Octokit's `RequestError`, `GraphqlResponseError`...).
 */
export class GitHubApiError extends Data.TaggedError("GitHubApiError")<{
  readonly status?: number;
  readonly cause: unknown;
}> {
  override get message() {
    return getErrorMessage(this.cause);
  }

  // Reports show the text of the original error ("HttpError: Not Found")
  override toString() {
    return String(this.cause);
  }
}

/** Wraps whatever a request threw, Octokit errors carry the HTTP `status` */
const toGitHubApiError = (cause: unknown) =>
  new GitHubApiError({
    cause,
    status:
      typeof cause === "object" &&
      cause !== null &&
      "status" in cause &&
      typeof cause.status === "number"
        ? cause.status
        : undefined,
  });

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
 * Creates the client and counts every request it sends (all API operations, pagination pages, GraphQL, retries by
 * the retry/throttling plugins) in the run metrics, in one place.
 * @throws {Error} if `GH_TOKEN` is not set
 */
const createOctokit = (onRequest: () => void): MyOctokitInstance => {
  const token = process.env.GH_TOKEN;
  if (!token) {
    throw new Error("GH_TOKEN is not set. A GitHub token is required to check GitHub links.");
  }
  const octokit = new MyOctokit({ auth: token, throttle: throttleOptions });
  octokit.hook.before("request", onRequest);
  return octokit;
};

export class GitHubClient extends Context.Tag("GitHubClient")<
  GitHubClient,
  {
    /** Runs a call of the client. Without `GH_TOKEN` it fails (with the reason), not the whole run. */
    readonly request: <T>(
      call: (octokit: MyOctokitInstance) => Promise<T>,
    ) => Effect.Effect<T, GitHubApiError>;
  }
>() {
  /** For tests: a client backed by `getOctokit` (can throw to simulate a missing `GH_TOKEN`) */
  static make = (getOctokit: () => MyOctokitInstance) =>
    GitHubClient.of({
      request: (call) =>
        Effect.tryPromise({ try: async () => call(getOctokit()), catch: toGitHubApiError }),
    });

  /**
   * One client per run, created on first use: a run without GitHub links does not need `GH_TOKEN`
   * (and offline unit tests can import GitHub modules).
   */
  static effect = Effect.gen(function* () {
    const metrics = yield* Metrics;
    // `increment` only updates a `Ref`, it is synchronous
    const onRequest = () => Effect.runSync(metrics.increment("githubApiRequests"));
    let octokit: MyOctokitInstance | undefined;
    return GitHubClient.make(() => (octokit ??= createOctokit(onRequest)));
  });

  static layer = Layer.effect(GitHubClient, GitHubClient.effect);
}

/** One call of the client: `githubRequest((octokit) => octokit.repos.get({ owner, repo }))` */
export const githubRequest = <T>(call: (octokit: MyOctokitInstance) => Promise<T>) =>
  Effect.flatMap(GitHubClient, (client) => client.request(call));

/** Requirements of the GitHub checks: the client, the metrics (cache hits) and the run cache */
export type GitHubServices = GitHubClient | Metrics | RunCache;
