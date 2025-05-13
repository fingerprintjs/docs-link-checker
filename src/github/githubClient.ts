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

export const myGithubClient = new MyOctokit({
  auth: GH_TOKEN,
  throttle: {
    onRateLimit: (retryAfter, options, octokit, retryCount) => {
      console.warn(`Request quota exhausted for request ${options.method} ${options.url}`);
      if (retryCount < 1) {
        console.info(`Retrying after ${retryAfter} seconds!`);
        return true;
      }
    },
    onSecondaryRateLimit: (retryAfter, options, octokit) => {
      console.warn(`SecondaryRateLimit detected for request ${options.method} ${options.url}`);
    },
  },
});
