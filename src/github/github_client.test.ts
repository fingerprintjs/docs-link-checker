import { it } from "@effect/vitest";
import {
  ConfigProvider,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  LogLevel,
  TestClock,
} from "effect";
import { describe, expect } from "vitest";
import { GitHubTimeout } from "../errors";
import { TASK_TIMEOUT } from "../http";
import { Metrics } from "../metrics";
import { settle } from "../test/clock";
import { type FetchHandler, fakeFetch } from "../test/fake_fetch";
import { GitHub, type FileInfo } from "./github_client";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * The real `GitHub` service over a fake `fetch`: what Octokit sends is observable, responses are made up.
 * Run services are fresh per `run`, so nothing is shared between runs.
 */
const setup = (handler: FetchHandler, token = "test-token") => {
  const fake = fakeFetch(handler);
  const layer = GitHub.layer.pipe(Layer.provideMerge(Layer.mergeAll(Metrics.layer, fake.layer)));
  return {
    calls: fake.calls,
    paths: () => fake.calls.map(({ url }) => new URL(url).pathname),
    run: <A, E>(use: Effect.Effect<A, E, GitHub | Metrics>) =>
      use.pipe(
        Effect.provide(layer),
        Effect.withConfigProvider(ConfigProvider.fromMap(new Map([["GH_TOKEN", token]]))),
        Effect.provide(Logger.minimumLogLevel(LogLevel.None)),
      ),
  };
};

const counter = (name: string) =>
  Effect.flatMap(Metrics, (metrics) => metrics.snapshot).pipe(
    Effect.map(({ counters }) => counters[name]),
  );

describe("GitHub without GH_TOKEN", () => {
  it.effect("builds, and fails requests with a clear error instead of crashing", () => {
    const { run, calls } = setup(() => json({}), "");
    return run(
      Effect.gen(function* () {
        const github = yield* GitHub;
        const exit = yield* Effect.exit(github.getRepo("o", "r"));

        expect(Exit.isFailure(exit) && String(exit.cause)).toContain("GH_TOKEN is not set");
        expect(calls).toHaveLength(0);
      }),
    );
  });
});

describe("GitHub request metrics", () => {
  it.effect("counts every request sent by the client, whatever the operation", () => {
    const { run, calls } = setup((url) =>
      url.includes("/graphql")
        ? json({ data: { repository: { discussion: { id: "D_1" } } } })
        : json({ id: 1, default_branch: "main", assets: [] }),
    );
    return run(
      Effect.gen(function* () {
        const github = yield* GitHub;
        yield* github.getRepo("o", "r");
        yield* github.getIssue("o", "r", 1);
        yield* github.getPullRequest("o", "r", 1);
        yield* github.getReleaseByTag("o", "r", "v1");
        yield* github.getDiscussion("o", "r", 1);

        expect(calls).toHaveLength(5);
        expect(yield* counter("githubApiRequests")).toBe(5);
      }),
    );
  });
});

describe("GitHub timeouts", () => {
  it.effect("fails with GitHubTimeout when a request takes longer than the task timeout", () => {
    const { run, calls } = setup(() => new Promise<Response>(() => {}));
    return run(
      Effect.gen(function* () {
        const github = yield* GitHub;
        const fiber = yield* Effect.fork(Effect.flip(github.getRepo("o", "r")));
        // The request is sent once Octokit has started it
        while (calls.length === 0) {
          yield* settle;
        }
        yield* TestClock.adjust(Duration.millis(TASK_TIMEOUT));

        const error = yield* Fiber.join(fiber);
        expect(error).toBeInstanceOf(GitHubTimeout);
        expect(error.message).toBe(`GitHub API check timed out after ${TASK_TIMEOUT}ms`);
        // The request is aborted, not left running
        expect(calls[0]?.init.signal?.aborted).toBe(true);
      }),
    );
  });
});

describe("GitHub responses", () => {
  it.effect("reads a file, and a directory as content-less", () => {
    const { run } = setup((url) =>
      url.includes("/contents/src")
        ? json([{ type: "file", name: "a.ts" }])
        : json({ type: "file", content: "aGk=", encoding: "base64", sha: "s1", size: 2 }),
    );
    return run(
      Effect.gen(function* () {
        const github = yield* GitHub;
        expect(yield* github.getContent("o", "r", "main", "a.txt")).toEqual({
          content: "aGk=",
          encoding: "base64",
          sha: "s1",
          size: 2,
        });
        expect((yield* github.getContent("o", "r", "main", "src")).content).toBeUndefined();
      }),
    );
  });

  it.effect("decodes file text, reads large files with the blobs API once per sha", () => {
    const text = "# Title\n\n## Usage\n";
    const { run, paths } = setup(() =>
      json({ content: Buffer.from(text).toString("base64"), encoding: "base64" }),
    );
    return run(
      Effect.gen(function* () {
        const github = yield* GitHub;
        const small = yield* github.getFileText("o", "r", {
          content: Buffer.from("one\ntwo").toString("base64"),
          sha: "small",
        });
        expect(small).toMatchObject({ text: "one\ntwo", binary: false });

        // Over 1 MB: no content in the contents API
        const large: FileInfo = { content: "", encoding: "none", sha: "large", size: 2_000_000 };
        const first = yield* github.getFileText("o", "r", large);
        // Same blob at another path
        yield* github.getFileText("o", "r", { ...large });

        expect(first.text).toBe(text);
        expect([...first.getAnchors()]).toEqual(["title", "usage"]);
        expect(paths()).toEqual(["/repos/o/r/git/blobs/large"]);
      }),
    );
  });

  it.effect("marks files with a NUL byte as binary", () => {
    const { run } = setup(() => json({}));
    return run(
      Effect.gen(function* () {
        const github = yield* GitHub;
        const file = yield* github.getFileText("o", "r", {
          content: Buffer.from([0x89, 0x50, 0x00, 0x0a]).toString("base64"),
          sha: "png",
        });
        expect(file.binary).toBe(true);
      }),
    );
  });

  it.effect("lists ref names of all pages without the `refs/<kind>/` prefix, cached", () => {
    const { run, calls } = setup((url) => {
      const page = new URL(url).searchParams.get("page");
      return page === "2"
        ? json([{ ref: "refs/heads/feature/b" }])
        : new Response(
            JSON.stringify([{ ref: "refs/heads/feature" }, { ref: "refs/tags/other" }]),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                link: '<https://api.github.com/repos/o/r/git/matching-refs/heads/feature?page=2>; rel="next"',
              },
            },
          );
    });
    return run(
      Effect.gen(function* () {
        const github = yield* GitHub;
        const names = yield* github.listRefNames("o", "r", "heads", "feature");
        yield* github.listRefNames("o", "r", "heads", "feature");

        // The listing can contain refs of the other kind, they are not names of this kind
        expect(names).toEqual(["feature", "feature/b"]);
        expect(calls).toHaveLength(2);
      }),
    );
  });

  it.effect("maps a GraphQL NOT_FOUND error to a 404, other GraphQL errors have no status", () => {
    let error = { type: "NOT_FOUND", message: "Could not resolve to a Discussion" };
    const { run } = setup(() => json({ data: null, errors: [error] }));
    return run(
      Effect.gen(function* () {
        const github = yield* GitHub;
        expect(yield* Effect.flip(github.getDiscussion("o", "r", 1))).toMatchObject({
          status: 404,
          isNotFound: true,
        });

        error = { type: "INTERNAL", message: "Something went wrong" };
        expect(yield* Effect.flip(github.getDiscussion("o", "r", 2))).toMatchObject({
          status: undefined,
          isNotFound: false,
        });
      }),
    );
  });

  it.effect("lists public repositories of an organization and the tree of a branch", () => {
    const { run, calls } = setup((url) =>
      url.includes("/orgs/org/repos")
        ? json([
            {
              full_name: "org/a",
              name: "a",
              archived: false,
              owner: { login: "org" },
              id: 1,
            },
          ])
        : json({ tree: [{ type: "blob", path: "README.md", sha: "x" }] }),
    );
    return run(
      Effect.gen(function* () {
        const github = yield* GitHub;
        expect(yield* github.listOrgRepos("org")).toEqual([
          { full_name: "org/a", name: "a", archived: false, owner: { login: "org" } },
        ]);
        expect(yield* github.getTreeEntries("org", "a", "main")).toEqual([
          { type: "blob", path: "README.md" },
        ]);
        expect(calls[0]?.url).toContain("type=public");
        expect(calls[1]?.url).toContain("/git/trees/main?recursive=1");
      }),
    );
  });

  it.effect("tells if a repository has releases and reads the rate limit", () => {
    let releases: unknown[] = [];
    const { run } = setup((url) =>
      url.endsWith("/rate_limit")
        ? json({ rate: { limit: 5000, remaining: 4999, reset: 1700000000, used: 1 } })
        : json(releases),
    );
    return run(
      Effect.gen(function* () {
        const github = yield* GitHub;
        expect(yield* github.hasReleases("o", "r")).toBe(false);
        releases = [{ id: 1 }];
        expect(yield* github.hasReleases("o", "r")).toBe(true);
        expect(yield* github.getRateLimit).toEqual({ remaining: 4999, reset: 1700000000 });
      }),
    );
  });
});
