import { Effect, Layer } from "effect";
import { RunLayer, type RunServices } from "../run";
import { GitHubClient, type GitHubServices } from "./github_client";

/**
 * Runs a GitHub check with all services of a run (a fresh one per call, so a fresh cache) and a client backed by a
 * fake Octokit: no network. `getOctokit` can throw to simulate a missing `GH_TOKEN`.
 */
export const runWithFakeOctokit = <A, E>(
  effect: Effect.Effect<A, E, GitHubServices | RunServices>,
  getOctokit: () => object,
) => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests fake only the used parts
  const client = GitHubClient.make(() => getOctokit() as never);
  return Effect.runPromise(
    effect.pipe(Effect.provide(Layer.mergeAll(RunLayer(), Layer.succeed(GitHubClient, client)))),
  );
};

/** Integration tests: runs a GitHub check with the real client (needs `GH_TOKEN`) and the services of a run */
export const runWithGitHub = <A, E>(effect: Effect.Effect<A, E, GitHubServices | RunServices>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(Layer.provideMerge(GitHubClient.layer, RunLayer()))),
  );
