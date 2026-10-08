/**
 * Fake `GitHub` service for tests of the check logic: overrides answer, everything else dies, calls are recorded.
 */
import { Effect, Layer } from "effect";
import { GitHub, type GitHubApi } from "../github/github_client";

// `Record` so a new method of `GitHubApi` must be listed here
const METHOD_NAMES: Record<keyof GitHubApi, true> = {
  getRepo: true,
  getUser: true,
  getCommit: true,
  getPullRequest: true,
  getIssue: true,
  getDiscussion: true,
  getReleaseByTag: true,
  getRelease: true,
  hasReleases: true,
  getContent: true,
  listRefNames: true,
  getFileText: true,
  listOrgRepos: true,
  getTreeEntries: true,
  getRateLimit: true,
};

type AnyMethod = (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown>;

/**
 * `calls` has one entry per call: `method(arg1, arg2)` with the arguments as JSON.
 * A method that is not overridden dies with `unexpected GitHub call: <method>`.
 */
export const fakeGitHub = (overrides: Partial<GitHubApi>) => {
  const calls: string[] = [];
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `Object.keys` loses the key type
  const entries = (Object.keys(METHOD_NAMES) as Array<keyof GitHubApi>).map((name) => {
    const override: unknown = overrides[name];
    if (name === "getRateLimit") {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `getRateLimit` is the only member that is an effect
      const effect = (override ?? Effect.die(`unexpected GitHub call: ${name}`)) as Effect.Effect<
        unknown,
        unknown
      >;
      return [name, Effect.suspend(() => (calls.push(name), effect))] as const;
    }
    const method: AnyMethod = (...args) => {
      calls.push(`${name}(${args.map((arg) => JSON.stringify(arg)).join(", ")})`);
      return typeof override === "function"
        ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the override has the signature of its own method
          (override as AnyMethod)(...args)
        : Effect.die(`unexpected GitHub call: ${name}`);
    };
    return [name, method] as const;
  });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the entries cover every key of `GitHubApi`, only their function types are erased
  const api = Object.fromEntries(entries) as unknown as GitHubApi;
  return { layer: Layer.succeed(GitHub, api), calls };
};
