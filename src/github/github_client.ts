import { existsSync } from "node:fs";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import { incrementMetric } from "../run";

// Optional local .env, existing env vars win (https://nodejs.org/api/process.html#processloadenvfilepath)
if (existsSync(".env")) {
  process.loadEnvFile();
}

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

export const throttleOptions = {
  onRateLimit: onRateLimited("Request quota exhausted"),
  onSecondaryRateLimit: onRateLimited("SecondaryRateLimit detected"),
} satisfies ThrottleOptions;

let client: MyOctokitInstance | undefined;

/**
 * Returns the shared Octokit client. The client is created lazily on first use,
 * so importing modules that use it does not require `GH_TOKEN` (e.g. in offline unit tests).
 * @throws {Error} if `GH_TOKEN` is not set
 */
export const getMyOctokit = (): MyOctokitInstance => {
  if (!client) {
    const token = process.env.GH_TOKEN;
    if (!token) {
      throw new Error("GH_TOKEN is not set. A GitHub token is required to check GitHub links.");
    }
    client = new MyOctokit({ auth: token, throttle: throttleOptions });
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
