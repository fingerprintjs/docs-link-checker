import { it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Logger, LogLevel } from "effect";
import { describe, expect } from "vitest";
import type { Fetch } from "../http";
import { HostLimiter } from "../limiter";
import { Metrics } from "../metrics";
import { type FetchHandler, fakeFetch } from "../test/fake_fetch";
import { checkLinkWithGithubApi } from "./gh_check_link";
import { GitHub } from "./github_client";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const file = (markdown: string) => ({
  type: "file",
  sha: "sha",
  content: Buffer.from(markdown).toString("base64"),
});

const FILE_URL = "https://github.com/owner/repo/blob/main/README.md";
const REPO_URL = "https://github.com/owner/repo";

/**
 * Real `GitHub` (with its caches) over a fake `fetch`. Each `run` has its own services, like a CLI run.
 * `count(path)` is the number of requests to an API path.
 */
const setup = (handler: FetchHandler) => {
  const fake = fakeFetch(handler);
  const layer = Layer.mergeAll(GitHub.layer, HostLimiter.layer(8)).pipe(
    Layer.provideMerge(Layer.mergeAll(Metrics.layer, fake.layer)),
  );
  return {
    count: (path: string) =>
      fake.calls.filter(({ url }) => decodeURIComponent(new URL(url).pathname) === path).length,
    run: <A, E>(effect: Effect.Effect<A, E, GitHub | HostLimiter | Metrics | Fetch>) =>
      effect.pipe(
        Effect.provide(layer),
        Effect.withConfigProvider(ConfigProvider.fromMap(new Map([["GH_TOKEN", "test-token"]]))),
        Effect.provide(Logger.minimumLogLevel(LogLevel.None)),
      ),
  };
};

/** Answers the repository and the README of `owner/repo` */
const defaultHandler: FetchHandler = (url) => {
  const { pathname } = new URL(url);
  return pathname.includes("/contents/")
    ? json(file("# Title\n## Usage\n"))
    : json({ default_branch: "main" });
};

describe("GitHub API cache (through checkLinkWithGithubApi)", () => {
  it.effect("dedupes concurrent checks of the same file within a run", () => {
    const { run, count } = setup(defaultHandler);
    return run(
      Effect.gen(function* () {
        const results = yield* Effect.all(
          Array.from({ length: 10 }, () => checkLinkWithGithubApi(FILE_URL)),
          { concurrency: "unbounded" },
        );
        expect(results.every((result) => result.ok)).toBe(true);
        // Later calls are cached too
        yield* checkLinkWithGithubApi(FILE_URL);

        expect(count("/repos/owner/repo/contents/README.md")).toBe(1);
      }),
    );
  });

  it.effect("caches different refs, paths and repositories separately", () => {
    const { run, count } = setup(defaultHandler);
    return run(
      Effect.gen(function* () {
        yield* Effect.all(
          [
            FILE_URL,
            "https://github.com/owner/repo/blob/develop/README.md",
            "https://github.com/owner/repo/blob/main/docs/README.md",
            "https://github.com/owner/other/blob/main/README.md",
          ].map(checkLinkWithGithubApi),
          { concurrency: "unbounded" },
        );

        expect(count("/repos/owner/repo/contents/README.md")).toBe(2);
        expect(count("/repos/owner/repo/contents/docs/README.md")).toBe(1);
        expect(count("/repos/owner/other/contents/README.md")).toBe(1);
      }),
    );
  });

  it.effect("caches repositories (case-insensitive)", () => {
    const { run, count } = setup(defaultHandler);
    return run(
      Effect.gen(function* () {
        yield* Effect.all(
          [REPO_URL, "https://github.com/Owner/Repo", REPO_URL].map(checkLinkWithGithubApi),
          { concurrency: "unbounded" },
        );

        expect(count("/repos/owner/repo")).toBe(1);
      }),
    );
  });

  it.effect("does not share the cache between runs", () => {
    const { run, count } = setup(defaultHandler);
    return Effect.gen(function* () {
      yield* run(checkLinkWithGithubApi(FILE_URL));
      yield* run(checkLinkWithGithubApi(FILE_URL));

      expect(count("/repos/owner/repo/contents/README.md")).toBe(2);
    });
  });

  for (const status of [404, 410]) {
    it.effect(`caches ${status} (the repository is definitely missing)`, () => {
      const { run, count } = setup(() => json({ message: "Gone" }, status));
      return run(
        Effect.gen(function* () {
          for (let i = 0; i < 2; i++) {
            expect(yield* checkLinkWithGithubApi(REPO_URL)).toMatchObject({
              ok: false,
              error: "broken link",
              status,
            });
          }

          expect(count("/repos/owner/repo")).toBe(1);
        }),
      );
    });
  }

  // Bad token or no access: no proof the repository is missing, ask again next time
  // (5xx are not covered: Octokit retries them for seconds)
  for (const status of [401, 403]) {
    it.effect(`does not cache ${status}`, () => {
      const { run, count } = setup(() => json({ message: "Failed" }, status));
      return run(
        Effect.gen(function* () {
          for (let i = 0; i < 2; i++) {
            expect(yield* checkLinkWithGithubApi(REPO_URL)).toMatchObject({
              ok: false,
              error: "unexpected error",
              status,
            });
          }

          expect(count("/repos/owner/repo")).toBe(2);
        }),
      );
    });
  }

  it.effect("checks many hashes of the same file with one API request", () => {
    const { run, count } = setup(defaultHandler);
    return run(
      Effect.gen(function* () {
        const hashes = ["", "#title", "#usage", "#missing"];
        const results = yield* Effect.all(
          hashes.map((hash) => checkLinkWithGithubApi(`${FILE_URL}${hash}`)),
          { concurrency: "unbounded" },
        );

        expect(count("/repos/owner/repo/contents/README.md")).toBe(1);
        expect(results.map((result) => result.ok)).toEqual([true, true, true, false]);
      }),
    );
  });

  it.effect("counts cache hits in the run metrics (requests are counted by the client)", () => {
    const { run } = setup(defaultHandler);
    return run(
      Effect.gen(function* () {
        yield* Effect.all([FILE_URL, FILE_URL, REPO_URL].map(checkLinkWithGithubApi), {
          concurrency: "unbounded",
        });

        const { counters } = yield* Effect.flatMap(Metrics, (metrics) => metrics.snapshot);
        expect(counters).toMatchObject({ githubCacheHits: 1, githubApiRequests: 2 });
      }),
    );
  });
});
