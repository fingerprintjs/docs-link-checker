import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import dotenv from "dotenv";
import { incrementMetric } from "../run_context";

// dotenv 17+ logs a message on every load, keep the output clean
dotenv.config({ quiet: true });

const MyOctokit = Octokit.plugin(retry, throttling);

type MyOctokitInstance = InstanceType<typeof MyOctokit>;
type ThrottleOptions = NonNullable<
  NonNullable<ConstructorParameters<typeof MyOctokit>[0]>["throttle"]
>;

/**
 * Retry once on both the primary and the secondary rate limit, then give up.
 */
export const throttleOptions = {
  onRateLimit: (retryAfter, options, octokit, retryCount) => {
    octokit.log.warn(`Request quota exhausted for request ${options.method} ${options.url}`);
    if (retryCount < 1) {
      octokit.log.info(`Retrying after ${retryAfter} seconds!`);
      return true;
    }
    return false;
  },
  onSecondaryRateLimit: (retryAfter, options, octokit, retryCount) => {
    octokit.log.warn(`SecondaryRateLimit detected for request ${options.method} ${options.url}`);
    if (retryCount < 1) {
      octokit.log.info(`Retrying after ${retryAfter} seconds!`);
      return true;
    }
    return false;
  },
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

/** Only for tests: forget the cached client */
export const resetMyOctokit = () => {
  client = undefined;
};

function readableMilliseconds(milliseconds: number) {
  const timeInSeconds = Math.floor(milliseconds / 1000);
  const seconds = timeInSeconds % 60;
  const minutes = Math.floor(timeInSeconds / 60) % 60;
  const hours = Math.floor(timeInSeconds / 3600) % 24;
  const days = Math.floor(timeInSeconds / 86400);
  return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

export async function checkGitHubRateLimit(
  octokit: ReturnType<typeof getMyOctokit> = getMyOctokit(),
) {
  const response = await octokit.rest.rateLimit.get();
  const resetTime = new Date(response.data.rate.reset * 1000);
  const millisecondsUntilReset = resetTime.getTime() - Date.now();

  const result = {
    remaining: response.data.rate.remaining,
    resetsIn: readableMilliseconds(millisecondsUntilReset),
    resetsOn: resetTime.toLocaleString("fr-FR"),
  };

  console.table(result);
  return result;
}
