import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import { getDeps, incrementMetric } from "../run";

const MyOctokit = Octokit.plugin(retry, throttling);

export type MyOctokitInstance = InstanceType<typeof MyOctokit>;
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

let client: MyOctokitInstance | undefined;

/**
 * Returns the shared Octokit client (or the one injected in the run). The client is created lazily on first use,
 * so importing modules that use it does not require `GH_TOKEN` (e.g. in offline unit tests).
 * @throws {Error} if `GH_TOKEN` is not set
 */
export const getMyOctokit = (): MyOctokitInstance => {
  const injected = getDeps().octokit;
  if (injected) {
    return injected();
  }
  if (!client) {
    const token = process.env.GH_TOKEN;
    if (!token) {
      throw new Error("GH_TOKEN is not set. A GitHub token is required to check GitHub links.");
    }
    // Resolved per request: the client is shared by all runs, the injected fetch belongs to a run
    const fetchOfRun: typeof fetch = (...args) => (getDeps().fetch ?? fetch)(...args);
    client = new MyOctokit({
      auth: token,
      throttle: throttleOptions,
      request: { fetch: fetchOfRun },
    });
    countRequests(client);
  }
  return client;
};

/**
 * Counts every request sent by the client (all API operations, pagination pages, the rate limit check,
 * GraphQL, retries by the retry/throttling plugins) in the run metrics, in one place.
 */
const countRequests = (octokit: Pick<MyOctokitInstance, "hook">) => {
  octokit.hook.before("request", () => {
    incrementMetric("githubApiRequests");
  });
};
