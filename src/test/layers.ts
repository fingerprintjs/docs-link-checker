/**
 * Run services for tests: real `Metrics` and `HostLimiter`, fakes for everything that touches the outside.
 */
import { Effect, Layer } from "effect";
import type { RunServices } from "../app";
import { Browser } from "../browser";
import { DEFAULT_HOST_CONCURRENCY } from "../config";
import type { GitHub } from "../github/github_client";
import { Fetch } from "../http";
import { HostLimiter } from "../limiter";
import { Metrics } from "../metrics";
import { fakeGitHub } from "./fake_github";

const unexpectedFetch = Layer.succeed(Fetch, (url) =>
  Promise.reject(new Error(`unexpected fetch: ${url}`)),
);
const dyingBrowser = Layer.succeed(Browser, {
  withPage: () => Effect.die("unexpected Browser use"),
});

/**
 * Unset `github` and `browser` die on use, unset `fetch` rejects (the failure shows up as a result of the
 * checked link, with the URL in its message).
 */
export const testRunLayer = (
  options: {
    readonly fetch?: Layer.Layer<Fetch>;
    readonly github?: Layer.Layer<GitHub>;
    readonly browser?: Layer.Layer<Browser>;
    readonly hostConcurrency?: number;
  } = {},
): Layer.Layer<RunServices> =>
  Layer.mergeAll(
    HostLimiter.layer(options.hostConcurrency ?? DEFAULT_HOST_CONCURRENCY),
    options.github ?? fakeGitHub({}).layer,
    options.browser ?? dyingBrowser,
  ).pipe(Layer.provideMerge(Layer.mergeAll(Metrics.layer, options.fetch ?? unexpectedFetch)));
