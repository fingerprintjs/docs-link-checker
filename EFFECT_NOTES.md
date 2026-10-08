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
  Every use is marked `// TODO(effect): convert`: `browser.ts`, `link.ts`, `fetch_check.ts`, `playwright_check.ts`, `page.ts`, `sitemap.ts`, `website.ts`, `local_files.ts`, `cli.ts`, `bench/bench.ts` and tests.

## Browser (phase 2)

- `browser.ts`: `withPage(use, { userAgent?, timeout })` returns an Effect (`BrowserSlot` required). The page is a scoped resource
  (`acquireRelease` for the context, `Effect.scoped`), so it is closed on success, failure and interruption.
  Max `PLAYWRIGHT_CONCURRENCY_LIMIT` pages at once (process-wide `Effect.unsafeMakeSemaphore`).
  Crash: if `use` or opening the page fails and the browser is disconnected, `BrowserSlot.discard` + one retry.
- `PageError` (`Data.TaggedError`, message and `toString` of the Playwright error) and `tryPage(fn)` wrap Playwright calls.
- `checkUrlsOnPageWithPlaywright(urls)` returns an Effect failing only with `BrowserLaunchError` / `PageError` (crash).
  Timeouts are real interruptions: response body read `Effect.timeout`, hung `page.evaluate` `Effect.timeoutFail` -> `TimeoutError`.
  502/503/504: `planServerErrorRetry` + `HostLimiter.pause`, wait with `waitUntilResumed` outside of the page slot. Time from `Clock`.
- Remaining shims: `link.ts` and `link.test.ts` / `link.integration.test.ts` call it through `runEffect` (`TODO(effect): convert`).
  `browser.test.ts` still uses `closeRunBrowser` from `effect_compat` for the `checkLinks` tests.

## Page and fetch (phase 2)

- `checkLinkWithFetch(url, pagesWithHash?)` (`fetch_check.ts`): `Effect<LinkCheckResult, never, HostLimiter | Metrics | RunCache>`.
  Failures are results. Each page is fetched once per run via `runCached` (key `fetch-page:<needBody>:<url without hash>`), `PageFetchCache` is gone.
  `pagesWithHash`: pages linked with a hash somewhere, their body is read for links without a hash too.
- `processInParallel({ items, processFn: item => Effect, concurrencyLimit })` (`utils.ts`): `{ results, errors }` in item order, failures (typed errors) do not stop other items,
  progress log via a scoped fiber. A defect (thrown inside an Effect) is not caught, it ends the call.
  `parallelProcess` (Promise) is a shim on top of it. `ConcurrentError<T, E>` moved from `limiter.ts` to `utils.ts`.
- `getWebsitePages(url)` (`sitemap.ts`): fails with `FetchError | TimeoutError | TooManyRedirects | SitemapStatusError`, nested sitemaps are fetched concurrently.
- `getLinksFromPages({ pages, linkFilter })` (`page.ts`): never fails, failed pages are in `errors` (`PageStatusError` or the fetch errors).
- `baseline.ts`: zod replaced by Effect `Schema`. `loadBaseline` and `writeBaseline` are Effects failing with `BaselineError` (`Data.TaggedError`).
  Validation messages changed (Schema wording, e.g. `ignore[0].url: is unexpected`), the path format and the first-issue-only rule stay.
- `github_actions.ts`: `writeJobSummary` and `writeGithubOutputs` are Effects (async append) failing with `GithubActionsError`.
- Pure helpers unchanged: `hash.ts`, `markdown.ts`, `line_anchor.ts`, `glob.ts`. `zod` and `p-limit` removed.
- Behavior change: the page cache lives for the run (`RunCache`), not for one `checkLinks` call.
  Outside `withRun` (tests) callers must provide a fresh `RunLayer()` per check, otherwise cached pages leak between tests.
- Remaining shims: `parallelProcess` (callers: `link.ts`, `github/gh_get_links.ts`), `runEffect` in `link.ts`, `website.ts`, `cli.ts`
  (`loadBaseline`, `writeBaseline`, `writeJobSummary`, `writeGithubOutputs`) and `link.test.ts`.

## GitHub

- `GitHubClient` (`github/github_client.ts`, `Context.Tag`): `request(call)` runs an Octokit call as `Effect.tryPromise`, fails with `GitHubApiError` (`Data.TaggedError`, `status`, `cause`, `toString` = text of the cause).
  `githubRequest(call)` is the shortcut. `GitHubClient.layer` needs `Metrics`, the Octokit client is created on first request per run (no `GH_TOKEN` is a `GitHubApiError` without status, not a crash). The request-counting hook counts `githubApiRequests`.
  `GitHubServices = GitHubClient | Metrics | RunCache`.
- `gh_api.ts`: `cachedRequest(key, call)` (uses `runCached`, caches only 404/410, counts `githubCacheHits`), `getRepoCached`, `isNotFoundApiError`, `getApiErrorResult` (take a `GitHubApiError`).
- All checks (`checkLinkWithGithubApi`, `checks/gh_simple.ts`, `checks/gh_content.ts`) are `Effect<LinkCheckResult, never, GitHubServices (| HostLimiter)>`: `GitHubApiError` is mapped to a result inside, like before.
- `gh_get_links.ts`: `getReadmesFromOrg` fails with `ListOrgReposError`, `getReadmeLinks` skips READMEs that fail with `ReadmeDownloadError` (via `processInParallel`). `checkReadmesInGithubOrg` is an Effect.
- Tests: `github/test_utils.ts` `runWithFakeOctokit(effect, () => fakeOctokit)` (full `RunLayer` + fake client), `runWithGitHub` for integration tests.
- `checks/gh_rate_limit.ts` (CI script) provides `GitHubClient.layer` and runs with `Effect.runPromise`.
- `effect_compat.runEffect` also provides `GitHubClient` (one per store), `getMyOctokit` and `tryCatch.ts` are gone.
- Remaining shims: `checkReadmesInGithubOrg` calls the Promise `checkLinks` via `Effect.promise` (TODO(effect): convert), `link.ts` and `cli.ts` call the GitHub Effects with `runEffect`, mocks of them in `link.test.ts` and `cli.test.ts` wrap Promise mocks in Effects.
