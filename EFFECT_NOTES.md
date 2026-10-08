# Effect architecture

`effect` 3.x (`pnpm add effect@^3`). `@effect/vitest` is not used (only 4.x supports vitest 5).
Conventions: https://effect.website/docs/

## Running

- One Promise boundary: `runCli` (`src/cli.ts`) runs each command once with `Effect.runPromise`.
  Commander option parsing stays Promise-based. Other entry points: `bench/bench.ts`, `checks/gh_rate_limit.ts`.
- `withApp(config)` (`src/app_layer.ts`) = `GitHubClient.layer` + `withRun(config)`. Use it once per entry point.
  It lives apart from `run.ts` because `github_client.ts` imports `Metrics` from `run.ts` (import cycle).
- `withRun(config)` (`src/run.ts`) provides `RunLayer`, closes the browser, then logs the run metrics (also on failure).
  A nested `withRun` starts a separate run.
- Code inside a run only declares the services it needs in `R`. No global state, nothing is cached outside a run.

## Services (`Context.Tag` classes with a static `layer`)

- `HostLimiter` (`limiter.ts`): per-host semaphore and host pauses (`run`, `pause`, `waitUntilResumed`). Uses `Clock`.
- `Metrics` (`run.ts`): `incrementMetric`, `timePhase`, `snapshot`.
- `RunCache` (`run.ts`): `runCached(key, effect, opts)`. Concurrent callers share one execution, failures are evicted
  unless `cacheError(e)`. Keys are namespaced by the callers. Fetched pages (`fetch_check.ts`) and GitHub 404s live here.
- `BrowserSlot` (`run.ts`): lazy shared Playwright browser (`get`, `discard`), closed with the run. `withPage` (`browser.ts`)
  opens a scoped page, max `PLAYWRIGHT_CONCURRENCY_LIMIT` at once, one retry after a browser crash.
- `GitHubClient` (`github/github_client.ts`): `githubRequest((octokit) => promise)`. Octokit is created on first use
  (a missing `GH_TOKEN` is a `GitHubApiError`, not a crash).
- `RunServices` = `HostLimiter | Metrics | RunCache | BrowserSlot`, `GitHubServices` = `GitHubClient | Metrics | RunCache`.

## Errors

- `Data.TaggedError`s: `FetchError`, `TimeoutError`, `TooManyRedirects`, `BrowserLaunchError` (`utils/errors.ts`),
  `PageError`, `GitHubApiError`, `BaselineError`, `GithubActionsError`, `LocalFilesError`, `NoMarkdownFilesError`, ...
- `message` and `toString` of wrappers are the cause's, so reports stay the same.
- Link check failures are results (`LinkCheckResult`), the error channel of checks is `never`.
  A failing first-pass or Playwright check becomes an "unexpected error" result in `checkLinks`.
- Handle by tag (`Effect.catchTag`) or `Effect.either`. No thrown errors inside effects.
  The CLI prints any other failure (including defects) as `Error: <stack>` and exits with 1.

## Style

- `Effect.gen` + `yield*`. Timeouts with `Effect.timeout*` (real cancellation), never `Promise.race`.
- Retry loops are recursive generators (the delay depends on the response, so no `Schedule`).
- `processInParallel` (`utils.ts`): `Effect.forEach` with a concurrency limit, `{ results, errors }` in item order.
  Typed failures of one item do not stop the others, a defect does.
- Pure code stays plain: `hash.ts`, `markdown.ts`, `line_anchor.ts`, `glob.ts`, report rendering and saving (`report/`),
  `getSampleRate` / `sampleItems` (throw on invalid options, called while parsing CLI options), `checkLocalLink` (sync fs lookups).
- `baseline.ts` validates with Effect `Schema` (messages use Effect's wording).

## Testing

- Run an Effect: `Effect.runPromise(effect.pipe(withApp()))` (`withRun()` when no GitHub client is needed).
  Use a fresh run per check, so cached pages and host pauses do not leak between tests.
- GitHub unit tests: `runWithFakeOctokit(effect, () => fakeOctokit)`. Integration tests: `runWithGitHub(effect)`
  (`src/github/test_utils.ts`).
- Fake timers (`vi.useFakeTimers`) work with the live `Clock`: advance them while the effect runs
  (`vi.advanceTimersByTimeAsync`). Several steps in one run (limiter pauses, metrics): one `Effect.gen`.
- Playwright is mocked with `vi.mock("playwright")` (`BrowserSlot` calls `chromium.launch`).
- Mocked modules that export Effects return `Effect.succeed(...)` / `Effect.promise(...)`.
