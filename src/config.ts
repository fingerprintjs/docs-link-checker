/**
 * Environment configuration. All env reads go through Effect `Config`, so tests swap the provider
 * (`ConfigProvider.fromMap`) instead of mutating `process.env`.
 * - https://effect.website/docs/configuration/
 */
import { parseEnv } from "node:util";
import { FileSystem } from "@effect/platform";
import { Config, ConfigProvider, Effect, Either, Option, Redacted } from "effect";

/** Default per-host concurrency (`--host-concurrency` / `LINK_CHECK_HOST_CONCURRENCY`) */
export const DEFAULT_HOST_CONCURRENCY = 8;

/** Float between 0 and 1. `label` is the flag or variable name shown in the message. */
export const parseSampleRate = (value: string, label: string): Either.Either<number, string> => {
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= 0 && rate <= 1
    ? Either.right(rate)
    : Either.left(`Invalid ${label} "${value}", expected a number between 0 and 1.`);
};

/** Maximum number of concurrent requests to a single host */
export const parseHostConcurrency = (
  value: string,
  label: string,
): Either.Either<number, string> => {
  const limit = Number(value);
  return Number.isInteger(limit) && limit >= 1
    ? Either.right(limit)
    : Either.left(`Invalid ${label} "${value}", expected a positive integer.`);
};

// Raw strings ("" = unset): the CLI parses them only when the flag is absent, so a flag can override an
// invalid env value and `--help` never fails. Typed `Config.number` would fail with `ConfigError` text instead.
const rawString = (name: string) => Config.string(name).pipe(Config.withDefault(""));

/** Env defaults of CLI options */
export const EnvOptions = Config.all({
  sampleRate: rawString("LINK_CHECK_SAMPLE_RATE"),
  hostConcurrency: rawString("LINK_CHECK_HOST_CONCURRENCY"),
  failOnBroken: rawString("FAIL_ON_BROKEN_LINKS"),
  baseline: rawString("LINK_CHECK_BASELINE"),
});

/** `None` if unset or empty */
export const GithubToken = rawString("GH_TOKEN").pipe(
  Config.map((token) => (token === "" ? Option.none() : Option.some(Redacted.make(token)))),
);

export type ActionsEnv = {
  readonly actions: string | undefined;
  readonly serverUrl: string | undefined;
  readonly repository: string | undefined;
  readonly sha: string | undefined;
  readonly workspace: string | undefined;
  readonly output: string | undefined;
  readonly stepSummary: string | undefined;
};

// Empty counts as unset: test setups and some runners define the variables with an empty value
const optionalString = (name: string) =>
  Config.string(name).pipe(
    Config.withDefault(""),
    Config.map((value) => value || undefined),
  );

/** Variables set by GitHub Actions, https://docs.github.com/en/actions/reference/variables-reference */
export const ActionsEnvConfig: Config.Config<ActionsEnv> = Config.all({
  actions: optionalString("GITHUB_ACTIONS"),
  serverUrl: optionalString("GITHUB_SERVER_URL"),
  repository: optionalString("GITHUB_REPOSITORY"),
  sha: optionalString("GITHUB_SHA"),
  workspace: optionalString("GITHUB_WORKSPACE"),
  output: optionalString("GITHUB_OUTPUT"),
  stepSummary: optionalString("GITHUB_STEP_SUMMARY"),
});

/**
 * Provider for production: environment variables first, then the `.env` file of the working directory
 * (same precedence as `process.loadEnvFile`, existing variables win). A missing or unreadable file is ignored.
 */
export const loadDotEnv: Effect.Effect<
  ConfigProvider.ConfigProvider,
  never,
  FileSystem.FileSystem
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dotEnv = yield* fs.readFileString(".env").pipe(Effect.option);
  const fromFile = Option.match(dotEnv, {
    onNone: () => new Map<string, string>(),
    onSome: (text) =>
      new Map(
        Object.entries(parseEnv(text)).flatMap(([key, value]) =>
          value === undefined ? [] : [[key, value] as const],
        ),
      ),
  });
  return ConfigProvider.fromEnv().pipe(
    ConfigProvider.orElse(() => ConfigProvider.fromMap(fromFile)),
  );
});
