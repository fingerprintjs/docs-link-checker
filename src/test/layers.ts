/**
 * Run services for tests: real `Metrics` and `HostLimiter`, fakes for everything that touches the outside.
 */
import { Effect, Layer } from "effect";
import type { RunServices } from "../app";
import { Browser, Chromium } from "../browser";
import { DEFAULT_HOST_CONCURRENCY } from "../config";
import type { GitHub } from "../github/github_client";
import { Fetch } from "../http";
import { HostLimiter } from "../limiter";
import { Metrics } from "../metrics";
import { fakeGitHub } from "./fake_github";

const unexpectedFetch = Layer.succeed(Fetch, (url) =>
  Promise.reject(new Error(`unexpected fetch: ${url}`)),
);
const unexpectedChromium = Layer.succeed(Chromium, {
  launch: () => Promise.reject(new Error("unexpected browser launch")),
  install: Effect.dieMessage("unexpected Chromium install"),
});

/**
 * Unset `github` dies on use, unset `fetch` and `chromium` (the real `Browser` runs over it) reject: the failure
 * shows up as a result of the checked link, with the URL in its message.
 */
export const testRunLayer = (
  options: {
    readonly fetch?: Layer.Layer<Fetch>;
    readonly github?: Layer.Layer<GitHub>;
    readonly chromium?: Layer.Layer<Chromium>;
    readonly hostConcurrency?: number;
  } = {},
): Layer.Layer<RunServices> =>
  Layer.mergeAll(
    HostLimiter.layer(options.hostConcurrency ?? DEFAULT_HOST_CONCURRENCY),
    options.github ?? fakeGitHub({}).layer,
    Browser.layer,
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Metrics.layer,
        options.fetch ?? unexpectedFetch,
        options.chromium ?? unexpectedChromium,
      ),
    ),
  );
