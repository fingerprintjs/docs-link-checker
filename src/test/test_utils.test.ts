import { it } from "@effect/vitest";
import { Console, Effect, Exit } from "effect";
import { describe, expect } from "vitest";
import { Browser } from "../browser";
import { GitHub } from "../github/github_client";
import { Fetch } from "../http";
import { HostLimiter } from "../limiter";
import { Metrics } from "../metrics";
import { runWithClock } from "./clock";
import { fakeFetch } from "./fake_fetch";
import { fakeGitHub } from "./fake_github";
import { testRunLayer } from "./layers";
import { makeTestConsole } from "./test_console";

describe("fakeFetch()", () => {
  it.effect("answers with the handler, records calls, rejects when the signal aborts", () =>
    Effect.promise(async () => {
      const { layer, calls } = fakeFetch((url) =>
        url.endsWith("/hang") ? new Promise<Response>(() => {}) : new Response("ok"),
      );
      const fetch = await Effect.runPromise(Effect.provide(Fetch, layer));

      expect(await (await fetch("https://a.example/", {})).text()).toBe("ok");
      const controller = new AbortController();
      const hanging = fetch("https://a.example/hang", { signal: controller.signal });
      controller.abort();
      await expect(hanging).rejects.toMatchObject({ name: "AbortError" });
      expect(calls.map((call) => call.url)).toEqual([
        "https://a.example/",
        "https://a.example/hang",
      ]);
    }),
  );
});

describe("fakeGitHub()", () => {
  it.effect("runs overrides, records the calls, and dies for the other methods", () => {
    const { layer, calls } = fakeGitHub({
      getRepo: () => Effect.succeed({ default_branch: "main" }),
    });
    return Effect.gen(function* () {
      const github = yield* GitHub;
      expect(yield* github.getRepo("o", "r")).toEqual({ default_branch: "main" });
      const exit = yield* Effect.exit(github.getUser("someone"));
      expect(Exit.isFailure(exit) && String(exit.cause)).toContain(
        "unexpected GitHub call: getUser",
      );
      expect(calls).toEqual(['getRepo("o", "r")', 'getUser("someone")']);
    }).pipe(Effect.provide(layer));
  });
});

describe("testRunLayer()", () => {
  it.effect(
    "has real metrics and limits, and fails when no Chromium or GitHub fake was given",
    () =>
      Effect.gen(function* () {
        yield* HostLimiter;
        yield* (yield* Metrics).increment("totalLinks");
        const browser = yield* Browser;
        expect(
          Exit.isFailure(yield* Effect.exit(browser.withPage({ timeout: 1 }, () => Effect.void))),
        ).toBe(true);
        const github = yield* GitHub;
        expect(Exit.isFailure(yield* Effect.exit(github.getRateLimit))).toBe(true);
      }).pipe(Effect.provide(testRunLayer())),
  );
});

describe("runWithClock()", () => {
  it.effect("moves the test clock while promise based fakes answer", () =>
    Effect.gen(function* () {
      const effect = Effect.gen(function* () {
        yield* Effect.promise(() => Promise.resolve());
        yield* Effect.sleep("10 seconds");
        yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
        yield* Effect.sleep("5 seconds");
        return "done";
      });
      expect(yield* runWithClock(effect, "15 seconds")).toBe("done");
    }),
  );
});

describe("makeTestConsole()", () => {
  it.effect("splits stdout and stderr like the real console", () => {
    const testConsole = makeTestConsole();
    return Effect.gen(function* () {
      yield* Console.log("a", 1);
      yield* Console.error("b");
      yield* Console.warn("c");
      expect(testConsole.stdout).toEqual(["a 1"]);
      expect(testConsole.stderr).toEqual(["b", "c"]);
    }).pipe(Effect.withConsole(testConsole.console));
  });
});
