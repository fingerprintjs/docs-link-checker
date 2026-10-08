# Effect rewrite notes

`effect` 3.x (`pnpm add effect@^3`, 4.x is not used). Docs: https://effect.website/docs/
Rewrite is done in phases, this file lists the state of the converted core and the temporary shims.

## Core API (phase 1)

- `withRun(config)(effect)` (`src/run.ts`): provides `RunLayer`, closes the browser, then logs the run metrics (also on failure).
  Call once at the entry point, a nested `withRun` starts a separate run.
- Services (`Context.Tag` classes), all part of `RunServices`:
  - `HostLimiter` (`limiter.ts`): `run(url, effect)` (per-host semaphore, interruption frees the slot), `pause`, `waitUntilResumed`, `limitPerHost`. Time from `Clock`.
  - `Metrics` (`run.ts`): `incrementMetric(name, by)`, `timePhase(name, effect)`, snapshot. Summary format is unchanged.
  - `RunCache` (`run.ts`): `runCached(key, effect, { cacheError, onHit, onMiss })`, concurrent callers share one run, failures are evicted unless `cacheError`.
  - `BrowserSlot` (`run.ts`): lazy shared Playwright browser (`get`, `discard`). Installs Chromium once if missing. Closed with the run.
- `fetchWithHostLimit(url, options, read)` (`http.ts`): Effect, `read` returns an Effect.
  Timeout interrupts the request (aborts `fetch`), covers `fetch` and `read` of each hop.
- `http.ts` helpers: `classifyStatus`, `getUserAgent`, `serverErrorResult` (pure), `planServerErrorRetry` (Effect: logs and counts the retry, needs `Metrics`), `readText`.
- Errors (`utils/errors.ts`, `Data.TaggedError`): `FetchError`, `TimeoutError`, `TooManyRedirects`, `BrowserLaunchError`.
  `FetchError` and `BrowserLaunchError` use the message of the cause.

## Conventions

- `Effect.gen` + `yield*`, handle errors by tag (`Effect.catchTag`) or `Effect.either`.
- Timeouts with `Effect.timeout*` (real interruption), never `Promise.race`.
- Retry loops are recursive generators (delay depends on the response, a `Schedule` cannot see it).
- Promise boundaries only at the CLI entry and in tests: `Effect.runPromise(effect.pipe(withRun(config)))`.
- Fake timers (`vi.useFakeTimers`) work with the live `Clock`, advance them while the effect runs.

## Temporary shims (remove when callers are Effects)

- `src/effect_compat.ts`: Promise API of the core (`withRun`, `getRunContext`, `getHostLimiter`, `closeRunBrowser`, `incrementMetric`, `timePhase`, `runCached`, `fetchWithHostLimit`, `planServerErrorRetry`, `withTimeout`, `runEffect`).
  Uses AsyncLocalStorage inside `withRun`, a default run outside of it. Starts effects synchronously (`immediate`), failures are rethrown as the original error.
  Every use is marked `// TODO(effect): convert`: `browser.ts`, `link.ts`, `fetch_check.ts`, `playwright_check.ts`, `page.ts`, `sitemap.ts`, `website.ts`, `local_files.ts`, `cli.ts`, `github/gh_api.ts`, `github/gh_get_links.ts`, `github/github_client.ts`, `bench/bench.ts` and tests.
- `src/utils/tryCatch.ts`: still used by `github/checks/gh_content.ts` and `gh_simple.ts`.
