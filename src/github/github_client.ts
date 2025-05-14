import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import dotenv from "dotenv";

dotenv.config();

const GH_TOKEN = process.env.GH_TOKEN;

if (!GH_TOKEN) {
  throw new Error("GH_TOKEN is not set");
}

const MyOctokit = Octokit.plugin(retry, throttling);

export const getMyOctokit = () =>
  new MyOctokit({
    auth: GH_TOKEN,
    throttle: {
      onRateLimit: (retryAfter, options, octokit, retryCount) => {
        octokit.log.warn(`Request quota exhausted for request ${options.method} ${options.url}`);
        if (retryCount < 1) {
          octokit.log.info(`Retrying after ${retryAfter} seconds!`);
          return true;
        }
      },
      onSecondaryRateLimit: (_retryAfter, options, octokit) => {
        octokit.log.warn(
          `SecondaryRateLimit detected for request ${options.method} ${options.url}`
        );
      },
    },
  });



  function readableMilliseconds(milliseconds: number) {
    const timeInSeconds = Math.floor(milliseconds / 1000);
    const seconds = timeInSeconds % 60;
    const minutes = Math.floor(timeInSeconds / 60) % 60;
    const hours = Math.floor(timeInSeconds / 3600) % 24;
    const days = Math.floor(timeInSeconds / 86400);
    return `${days}d ${hours}h ${minutes}m ${seconds}s`;
  }

  export async function checkGitHubRateLimit(octokit: ReturnType<typeof getMyOctokit>) {
    const response = await octokit.rest.rateLimit.get();
    const resetTime = new Date(response.data.rate.reset * 1000);
    const millisecondsUntilReset = resetTime.getTime() - Date.now();

    console.table({
      "Remaining GitHub API requests": response.data.rate.remaining,
      "Resets in": readableMilliseconds(millisecondsUntilReset),
      "Resets on": resetTime.toLocaleString("fr-FR"),
    });
  }
