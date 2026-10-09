# Experiment: rewrite in Effect

Question: would this codebase benefit from [Effect](https://effect.website)? Answer: no, not as a migration. Kept for reference, not for merging.

## What was built

Both versions are on this branch, on top of main `9f89352`:

- **v1, literal port** (`54d11bb..3e83735`): main's design translated to Effect 3. Effect used as `async`/`await` + dependency injection. [Diff vs main](https://github.com/fingerprintjs/docs-link-checker/compare/9f89352...3e83735)
- **v2, from scratch** (`6ec91c1..468a7e5`): designed first for Effect best practices (`docs/architecture.md`), then built from main's code by parallel agents. [Diff vs main](https://github.com/fingerprintjs/docs-link-checker/compare/9f89352...468a7e5)

Both keep user-visible behavior: CLI output, exit codes, reports, baseline format. Unit tests and checks pass. Integration tests, `bench` and real-browser CLI runs were not run.

## Numbers

|                  | Source lines (non-test `src/`) | vs main | Tests | Test lines  |
| ---------------- | ------------------------------ | ------- | ----- | ----------- |
| main             | 5205                           |         | 536   | 5989        |
| v1, port         | 5536                           | +6%     | 552   |             |
| v2, from scratch | 5768                           | +11%    | 606   | 8674 (+45%) |

The v2 design predicted -11%. It came out +11%.

Where v2 grew:

- GitHub client 64 → 434 lines: every Octokit call is a typed, cached method on a service, so tests can swap in a fake
- New infrastructure modules, about +375 lines: `metrics`, `errors`, `config`, `logger`, `app`

Where v2 shrank: `run.ts` deleted (-192), `gh_content` -71, `gh_api` -46, `limiter` -40, `tryCatch` deleted (-27), `gh_simple` -25.

## What v2 does better

- Tests: no `vi.mock`. Fetch, GitHub, Chromium, file system, console and environment are services, tests pass fakes. Time is controlled with `TestClock`. CLI tests run end to end over the real pipeline.
- No module-level state: browser, caches, metrics and the GitHub client live per run.
- Logging and config: `Effect.log` replaces swapping `console` for `--json`, env reads go through `Config`.
- Typed errors, and timeouts stop the work.

## Effect features that did not fit

Each was considered in the v2 design and rejected:

- `Stream`, `Request`/`RequestResolver`: no batching or backpressure problem to solve
- `Schedule` for the HTTP retry loop: the host must be paused while the request still holds the host slot, a schedule runs after the slot is released
- `HttpClient`: manual redirects with a host slot per hop and body cancel inside the slot don't fit it
- `@effect/cli`: accepts invalid flags that commander rejects, changes usage errors, adds options to every command
- `effect/Metric`: process-wide registry, metrics here are per run

## Verdict

- Writing it in Effect from the start gives a more uniform and more testable codebase, but not a smaller one.
- Most of the code is domain logic (GitHub URL parsing, hash matching, markdown, reports, baseline) that is the same in any style. Effect's value here is testing and wiring, at about +10% source and +45% test code.
- New project, team knows Effect: a defensible choice.
- Migrating this repo: not worth it.

## Lessons taken back to main

1. Inject dependencies (fetch, Octokit, Chromium) through the run context, tests pass fakes instead of `vi.mock`.
2. Cancel timed-out work with `AbortSignal`, mainly the GitHub check timeout (it kept sending API requests).
3. No side effects on import (`.env` loading, `GH_TOKEN` read), per-run state instead of module globals (Playwright page limit).
4. Named error classes for expected failures, where callers or tests check them.

Module architecture: little to take. Main already has deep modules. v2 added infrastructure modules and a large GitHub facade whose main purpose is testability, which lesson 1 gets with less code.

## Process notes (agents)

- First attempt: phased port with agents in one shared working tree and temporary Promise shims. Worked, but agents saw each other's half-done edits.
- Second attempt: design first with exact interfaces between groups, a foundation step with stubs, then parallel agents in separate git worktrees, then one integration and review step. Fewer collisions, no shims.
- Agent worktrees start from `main`: each agent had to reset to the foundation commit first.
