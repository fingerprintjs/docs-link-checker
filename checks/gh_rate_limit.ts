// Fails the CI job early when the GitHub API quota is almost used up: link checks would hit the rate limit and
// end as "could not check" or network errors instead of real results.
import { Effect } from "effect";
import { runLive } from "../src/app";
import { GitHub } from "../src/github/github_client";

const MIN_REMAINING_REQUESTS = 200;

const rate = await runLive(Effect.flatMap(GitHub, (github) => github.getRateLimit));
console.log(`GitHub API requests remaining: ${rate.remaining}`);
if (rate.remaining < MIN_REMAINING_REQUESTS) {
  console.error(
    `Too few requests left, run again after ${new Date(rate.reset * 1000).toISOString()}.`,
  );
  process.exitCode = 1;
}
