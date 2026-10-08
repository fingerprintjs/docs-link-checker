// Fails the CI job early when the GitHub API quota is almost used up: link checks would hit the rate limit and
// end as "could not check" or network errors instead of real results.
import { Effect, Layer } from "effect";
import { GitHubClient, githubRequest } from "../src/github/github_client";
import { Metrics } from "../src/run";

const MIN_REMAINING_REQUESTS = 200;

const checkRateLimit = Effect.gen(function* () {
  const { data } = yield* githubRequest((octokit) => octokit.rest.rateLimit.get());
  const { rate } = data;
  console.log(`GitHub API requests remaining: ${rate.remaining}`);
  if (rate.remaining < MIN_REMAINING_REQUESTS) {
    console.error(
      `Too few requests left, run again after ${new Date(rate.reset * 1000).toISOString()}.`,
    );
    process.exitCode = 1;
  }
});

await Effect.runPromise(
  checkRateLimit.pipe(Effect.provide(Layer.provide(GitHubClient.layer, Metrics.layer))),
);
