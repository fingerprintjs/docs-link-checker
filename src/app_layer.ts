/**
 * All services of the app: the run (see `run.ts`) plus the GitHub client.
 * Lives apart from `run.ts` because `github_client.ts` imports `Metrics` from it (import cycle).
 */
import { Effect } from "effect";
import { GitHubClient } from "./github/github_client";
import { type RunConfig, withRun } from "./run";

/**
 * Runs `effect` as a link-check run with the GitHub client (see `withRun`). Use it once, at the entry point.
 * ```ts
 * await Effect.runPromise(checkLinks(args).pipe(withApp()));
 * ```
 */
export const withApp =
  (config: RunConfig = {}) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(GitHubClient.layer), withRun(config));
