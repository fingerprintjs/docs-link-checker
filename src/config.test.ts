import { FileSystem } from "@effect/platform";
import { SystemError } from "@effect/platform/Error";
import { it } from "@effect/vitest";
import { Config, ConfigProvider, Effect, Either, Option, Redacted } from "effect";
import { describe, expect, vi } from "vitest";
import {
  ActionsEnvConfig,
  EnvOptions,
  GithubToken,
  loadDotEnv,
  parseHostConcurrency,
  parseSampleRate,
} from "./config";

const withEnv = (env: Record<string, string>) =>
  Effect.withConfigProvider(ConfigProvider.fromMap(new Map(Object.entries(env))));

describe("parseSampleRate()", () => {
  it("accepts numbers from 0 to 1", () => {
    expect(parseSampleRate("0.1", "--sample-rate")).toEqual(Either.right(0.1));
    expect(parseSampleRate("0", "--sample-rate")).toEqual(Either.right(0));
    expect(parseSampleRate("1", "--sample-rate")).toEqual(Either.right(1));
  });

  it.each(["abc", "-0.1", "1.5", "NaN"])("rejects %s, naming the flag or variable", (value) => {
    expect(parseSampleRate(value, "LINK_CHECK_SAMPLE_RATE")).toEqual(
      Either.left(`Invalid LINK_CHECK_SAMPLE_RATE "${value}", expected a number between 0 and 1.`),
    );
  });
});

describe("parseHostConcurrency()", () => {
  it("accepts positive integers", () => {
    expect(parseHostConcurrency("8", "--host-concurrency")).toEqual(Either.right(8));
  });

  it.each(["0", "-1", "1.5", "abc"])("rejects %s", (value) => {
    expect(parseHostConcurrency(value, "--host-concurrency")).toEqual(
      Either.left(`Invalid --host-concurrency "${value}", expected a positive integer.`),
    );
  });
});

describe("env configuration", () => {
  it.effect(
    "EnvOptions are raw strings, empty when unset (invalid values are not parsed here)",
    () =>
      Effect.gen(function* () {
        expect(yield* EnvOptions).toEqual({
          sampleRate: "",
          hostConcurrency: "",
          failOnBroken: "",
          baseline: "",
        });
        expect(
          yield* EnvOptions.pipe(
            withEnv({
              LINK_CHECK_SAMPLE_RATE: "abc",
              LINK_CHECK_HOST_CONCURRENCY: "4",
              FAIL_ON_BROKEN_LINKS: "false",
              LINK_CHECK_BASELINE: "my.json",
            }),
          ),
        ).toEqual({
          sampleRate: "abc",
          hostConcurrency: "4",
          failOnBroken: "false",
          baseline: "my.json",
        });
      }),
  );

  it.effect("GithubToken is None when unset or empty, otherwise redacted", () =>
    Effect.gen(function* () {
      expect(yield* GithubToken).toEqual(Option.none());
      expect(yield* GithubToken.pipe(withEnv({ GH_TOKEN: "" }))).toEqual(Option.none());
      const token = yield* GithubToken.pipe(withEnv({ GH_TOKEN: "secret" }));
      expect(Option.map(token, Redacted.value)).toEqual(Option.some("secret"));
      expect(String(token)).not.toContain("secret");
    }),
  );

  it.effect("ActionsEnvConfig reads the GitHub Actions variables, empty counts as unset", () =>
    Effect.gen(function* () {
      expect(
        yield* ActionsEnvConfig.pipe(
          withEnv({
            GITHUB_ACTIONS: "true",
            GITHUB_SERVER_URL: "https://github.com",
            GITHUB_REPOSITORY: "owner/repo",
            GITHUB_SHA: "abc",
            GITHUB_WORKSPACE: "/work",
            GITHUB_OUTPUT: "",
          }),
        ),
      ).toEqual({
        actions: "true",
        serverUrl: "https://github.com",
        repository: "owner/repo",
        sha: "abc",
        workspace: "/work",
        output: undefined,
        stepSummary: undefined,
      });
    }),
  );

  it.effect("fails with a ConfigError when a variable cannot be read as a string", () =>
    Config.string("MISSING").pipe(withEnv({}), Effect.flip, Effect.asVoid),
  );
});

describe("loadDotEnv", () => {
  /** A file system where `.env` has `content` (`undefined` = no such file) */
  const fileSystem = (content: string | undefined) =>
    FileSystem.layerNoop({
      readFileString: (path) =>
        content === undefined
          ? Effect.fail(
              new SystemError({
                reason: "NotFound",
                module: "FileSystem",
                method: "readFileString",
                pathOrDescriptor: path,
              }),
            )
          : Effect.succeed(content),
    });

  const read = (name: string, content: string | undefined) =>
    Effect.gen(function* () {
      const provider = yield* loadDotEnv;
      return yield* Config.string(name).pipe(Effect.withConfigProvider(provider), Effect.option);
    }).pipe(Effect.provide(fileSystem(content)));

  it.effect("reads variables from the .env file", () =>
    Effect.gen(function* () {
      const content = 'DOTENV_ONLY=from file\n# comment\nQUOTED="a b"\n';
      expect(yield* read("DOTENV_ONLY", content)).toEqual(Option.some("from file"));
      expect(yield* read("QUOTED", content)).toEqual(Option.some("a b"));
    }),
  );

  it.effect("environment variables win over the .env file", () => {
    vi.stubEnv("DOTENV_BOTH", "from env");
    return Effect.gen(function* () {
      expect(yield* read("DOTENV_BOTH", "DOTENV_BOTH=from file")).toEqual(Option.some("from env"));
    });
  });

  it.effect("works without a .env file", () =>
    Effect.gen(function* () {
      expect(yield* read("DOTENV_MISSING", undefined)).toEqual(Option.none());
    }),
  );
});
