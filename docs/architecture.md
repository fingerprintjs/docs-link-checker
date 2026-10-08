# Architecture

TypeScript on [Effect](https://effect.website/docs/getting-started/introduction/) 3. Pure domain code (hashes, markdown, GitHub URLs, report rendering, baseline matching) is plain functions. Everything that touches the outside is an Effect service, so tests replace it with a fake.

## Run

- `bin/docs-link-checker.js` calls `runCli` (`src/cli.ts`), the only `Effect.runPromise` of the app. Scripts (`bench/`, `checks/`) use `runLive` (`src/app.ts`).
- `runCliEffect` never fails, it returns the exit code: 0 ok, 1 links to fix or crash, 2 usage or baseline error, 130 interrupted (SIGINT / SIGTERM).
- A command is one flat Effect: parse flags and env, load the baseline, check links, write reports / job summary / outputs, update the baseline, exit code.
- A **run** is a command or a bench round. `liveRunLayer` builds fresh services per run and closes them at the end. No module-level mutable state.
- Only the link check part runs inside the run layer, so usage errors and `--dry-run` print no "Run metrics:".

## Services (`Context.Tag` + `static layer`)

| Service       | Module                        | Role                                                                            |
| ------------- | ----------------------------- | ------------------------------------------------------------------------------- |
| `Fetch`       | `src/http.ts`                 | The only reference to `globalThis.fetch`. Also given to Octokit.                |
| `HostLimiter` | `src/limiter.ts`              | Concurrent requests per host (semaphore) and host pauses (429, 5xx).            |
| `Metrics`     | `src/metrics.ts`              | Per-run counters and phases. The layer finalizer logs the summary.              |
| `GitHub`      | `src/github/github_client.ts` | Typed GitHub API methods (Octokit inside), caches, timeouts. No token at build. |
| `Chromium`    | `src/browser.ts`              | The only reference to Playwright's `chromium` (launch, install).                |
| `Browser`     | `src/browser.ts`              | Lazy shared browser, page slots, relaunch after a crash.                        |
| `FileSystem`  | `@effect/platform`            | All file I/O except one `glob` call in `src/local_files.ts`.                    |

- Build order matters: `Metrics` is built first and closed last, so its summary comes after the browser closed.
- Fakes are `Layer.succeed(Tag, impl)`. No `Effect.Service`, no `vi.mock` of own modules.

## Link check pipeline (`src/link.ts`)

- `checkLinks`: unique hrefs, interleaved by host, first pass with `processAll` (bounded concurrency, failures do not stop others).
- First pass method per link: plain `fetch` (`src/fetch_check.ts`, one fetch per page through a `Cache`), GitHub API (`src/github/`), or invalid (reported without a request).
- Failures that the method may cause (client-side rendering, bot blocking, rate limits, network errors) are re-checked with Playwright, one navigation per page for all its hashes (`src/playwright_check.ts`). Definitive answers (404 from the API) are not.
- A check that fails or dies becomes an "unexpected error" result, no re-check.
- Commands: `site` (`src/website.ts`, `src/sitemap.ts`, `src/page.ts`), `files` (`src/local_files.ts`), `github-org` (`src/github/gh_get_links.ts`).

## HTTP (`fetchLimited`)

- Every redirect hop takes a slot of its own host (manual redirects, max 10).
- 429 with `Retry-After` and 502 / 503 / 504 are retried (max 2). The host is paused inside the slot, before it is released, so queued requests do not start during the pause. This is why the retry loop is explicit and not `Effect.retry`: a schedule computes the delay after the slot is gone.
- Unread bodies are cancelled before the slot is released. Each hop has a timeout, interruption aborts the request.
- The semaphore is not strictly FIFO: a retry that releases and takes a slot again can overtake queued requests. They wait for the same pause anyway.

## GitHub client

- Caches (`Cache`, infinite TTL, concurrent callers share one lookup): repos, users, contents, ref lists, file texts. Only "not found" failures stay cached, rate limits and 5xx are asked again.
- Keys lowercase owner and repo. Each request has a timeout (`GitHubTimeout`) and an abort signal.
- Octokit keeps its retry and throttling plugins for secondary rate limits.

## Browser

- `RcRef` launches Chromium on the first page and closes it with the layer. A failed launch is not kept. No browser is started when nothing needs a re-check.
- A missing executable installs Chromium once, then launches again.
- A crashed (disconnected) browser is relaunched and the page operation runs once more.
- Each page is a fresh context. Images, media, fonts and analytics are blocked. At most 5 pages at a time.

## Config, logging, errors

- Env goes through `Config` and the ambient `ConfigProvider` (`src/config.ts`): process env, then `.env` of the working directory. Option env defaults are raw strings, parsed only when the flag is absent, so `--help` and overriding flags work with invalid variables.
- Logs are `Effect.log*` with a plain-text logger (`src/logger.ts`): info to stdout, warnings and errors to stderr. With `--json` everything goes to stderr and stdout is only the report. Output of the CLI itself uses `Console`.
- Typed errors in `src/errors.ts` (`Data.TaggedError`). Expected failures are values in the `E` channel, bugs are defects.
- Lint (`.oxlintrc.jsonc`) forbids `console`, `process.env`, `Date.now`, `setTimeout`, global `fetch` and `node:fs` in `src/` (exempt: tests, `bench/`, `checks/`, `bin/`).

## CLI and baseline

- `commander` parses flags only (sync, buffered output, printed through `Console`). `@effect/cli` was rejected: it swallows unknown options as globs (`files a.md --include x`), exits 1 with tagged JSON dumps for usage errors and adds options (`--completions`, `--wizard`, ...).
- The baseline file is validated with `Schema`. Error text is `<path>: <message>` (exit code 2).
- Reports (`src/report/report.tsx`) and the job summary / annotations / outputs (`src/github_actions.ts`) are pure rendering plus writes through `FileSystem`.

## Tests

- `@effect/vitest`: `it.effect` runs on `TestClock`, `it.live` for real time.
- Fakes in `src/test/`: `fakeFetch` (HTTP and Octokit), `fakeGitHub`, `fakeChromium` (cheerio evaluates selectors), `makeTestConsole`, `testRunLayer` (real `Metrics` and `HostLimiter`), `runWithClock` (moves the clock until the effect is done).
- `src/cli.test.ts` runs the commands end to end over the real pipeline: temp dirs, fake `fetch`, fake `GitHub`.
- `*.integration.test.ts` use the real network and GitHub API (`pnpm run test:integration`).
- Browser specific behavior (selector syntax, real hash navigation) is only covered by the integration tests.

## Not used on purpose

- `HttpClient`: needs per-hop slots with the body read inside the slot and manual redirects.
- `effect/Metric`: process-global registry, no per-run totals, cannot print the summary text.
- `Request` / `RequestResolver`: nothing to batch, and it caches failures indiscriminately.
- `Stream`: results are needed as a whole.
