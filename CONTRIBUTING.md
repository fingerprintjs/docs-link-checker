# Contributing

## Setup

- Node.js version is defined in `.nvmrc` (and `engines.node`), pnpm version in the `packageManager` field of `package.json` (use `corepack enable` or install the matching pnpm).
- The project is ESM (`"type": "module"`). TypeScript runs directly with `tsx` (link checks) and vitest (tests), `tsc` only type-checks.
- `pnpm install`, `pnpm run tsc`, `pnpm test` (single run) or `pnpm run test:watch`.
- In this repository, `pnpm cli` runs the [CLI](README.md#cli) (`tsx src/cli.ts`). It takes the same arguments as the `docs-link-checker` bin.

## Format and lint

Format with [oxfmt](https://oxc.rs/docs/guide/usage/formatter) (`.oxfmtrc.json`, also sorts imports) and lint with [oxlint](https://oxc.rs/docs/guide/usage/linter) (`.oxlintrc.jsonc`). The linter runs type-aware rules (floating promises, `any` leaks, unsafe type assertions, deprecated APIs), limits function complexity (`sonarjs/cognitive-complexity`, max 20), and bans skipped and focused tests. Warnings fail too.

- `pnpm run check` runs everything CI runs except tests: formatter check, linter, suppression check, `tsc` and [knip](https://knip.dev/) (unused files, exports and dependencies).
- `pnpm run check:fix` formats and applies safe lint fixes, `pnpm run lint` only lints, `pnpm run format` only formats.
- Fix findings instead of suppressing them. A suppression (`// oxlint-disable-next-line rule -- reason`) needs a reason, and their number is capped (`pnpm run lint:suppressions`, `checks/lint_suppressions.ts`).

## Tests

- `pnpm test` runs offline unit tests (`*.test.ts`). They mock `fetch` (and DNS), the GitHub API and Playwright, and need no network or `GH_TOKEN`.
- `pnpm run test:coverage` runs them with coverage (CI). It fails when coverage drops below the thresholds in `vitest.config.js`.
- `pnpm run test:integration` runs integration tests (`*.integration.test.ts`) against real websites and the GitHub API. They need network access, Playwright's Chromium and a `GH_TOKEN` environment variable.
- `.github/workflows/action-selftest.yaml` tests the action (`uses: ./`) on the offline fixture in `test/action-fixture/`.

## Link check scripts

The package scripts used by the workflow (`pnpm run checkLinks:docs`, `checkLinks:github`, `checkLinks:web`) run the [CLI](README.md#cli) (`site` and `github-org` commands), `pnpm run checkLinks:files` checks the README. They need a `GH_TOKEN` environment variable (can also be set in a `.env` file). They exit with code 1 when broken links are found. Set `FAIL_ON_BROKEN_LINKS=false` to only report them. The `site` and `github-org` scripts use the [baseline file](README.md#baseline-file) `linkcheck.baseline.json` at the repository root: it ignores links on hosts that require a login or block automated clients (they would always be "could not check"). Add hosts there with a `reason`, never real broken links.

## Code map

`src/cli.ts` (CLI), `src/website.ts` (`site`), `src/github/gh_get_links.ts` (`github-org`), `src/local_files.ts` (`files`), `src/link.ts` (`checkLinks`, the shared checking pipeline), `src/fetch_check.ts` and `src/playwright_check.ts` (single link checks), `src/baseline.ts`, `src/report/report.tsx` (JSON and HTML reports), `src/github_actions.ts` (job summary, annotations, step outputs), `action.yml` (reusable action).

## How checks run

- Set `LINK_CHECK_SAMPLE_RATE` (a number between `0` and `1`, default `1`) to check only a part of the pages (website sitemap pages, GitHub README files). The sample is deterministic (pages are sorted, then every Nth page is picked) and has at least one page. On pull requests, the workflow uses `LINK_CHECK_SAMPLE_RATE=0.1` to keep CI fast. On `main` and manual runs, it checks everything.
- Set `LINK_CHECK_HOST_CONCURRENCY` (a positive integer, default `8`) to change the maximum number of concurrent `fetch` requests to a single host. It applies to every `fetch` request of a run (sitemaps, source pages, README downloads, link checks), and to every redirect hop (limited by the host it goes to). A `429` response with `Retry-After` pauses requests to that host, and the request is retried. Sitemaps are also limited to 5 concurrent fetches overall. GitHub API requests are limited by Octokit instead, and Playwright navigations by the browser's page limit.
- A `502`, `503` or `504` (an overloaded server, github.com also returns `503` under load) is retried twice, after 2s and 5s, or after `Retry-After` if it asks for longer (at most 10s, a longer `Retry-After` is not waited for). Like a `429`, the retry pauses all requests to that host, Playwright navigations included. If the error persists (also in the browser), the link is reported as "could not check" with the status, not as broken. The wait adds at most 20s per request or navigation. GitHub API requests are retried by Octokit (3 times on 5xx), a persisting server error is re-checked with Playwright.
- Pages are fetched with `GET`, once per page. The body is only read if a link to the page has a hash (or the response is an error, for the error detail), otherwise it is cancelled, so large files are not downloaded. `HEAD` is not used: some servers refuse it or answer it differently (support.google.com and chatgpt.com return `404` to `HEAD` and `200` to `GET`). A `502`/`503`/`504` is retried with a backoff.
- Hashes not found in the server HTML are checked in Chromium: all links to the same page share one navigation, and the anchors of all of them are waited for in parallel, 15 seconds in total per page (client-side rendered docs like Mintlify and the Terraform Registry add some anchors late, even after the page looks idle). Anchors that appear earlier return right away, a missing anchor takes the whole 15 seconds, unless the DOM stops changing for 2 seconds first (the page is done rendering). Anchors still missing then (the page might render content per hash, like SPA tabs) are retried one by one: the hash is set in the same page and the anchor is waited for up to 3 more seconds. Text fragments (`:~:`), `#/` and Google Help accordion states (`#zippy=...` on support.google.com) are accepted without an element.
- GitHub code line links (`#L12`, `#L12-L15`, with columns `#L12C5-L15C1`, on `github.com/<owner>/<repo>/blob/...`) are checked with the GitHub API, not in the browser (github.com refuses blob pages to headless browsers on CI runners with `503`): the file is read once per run (files over 1 MB with the blob API) and its last linked line must be in the file (lines start at 1, ranges go forward, `#L0` is invalid, a trailing newline does not count as a line, binary files have no lines). On a rendered markdown file (without `?plain=1`), a heading slug like `l12` is accepted too. Branch and tag names with slashes (`blob/feature/x/src/a.ts`, any number of segments, also in `tree/...` links) are resolved when the first segment is not a ref with the file: the branches and tags starting with it are listed once per repository and first segment (cached for the run), the longest one the URL starts with is the ref. A missing file or repository (`404`, also private repositories the token can't see, or `410` Gone) is a broken link. If the API can't answer (no `GH_TOKEN`, a bad token `401`, `403` (rate limited after Octokit's retry, or no access), `429`, server or network errors), the link falls back to the browser, which checks the line numbers of the rendered code view (a persisting `503` there is "could not check").
- GitHub URLs are decoded before they are passed to the GitHub API (tags like `%40scope%2Fpkg%401.0.0`), and `https://github.com/<owner>` is checked as a user or organization (and as a page if the API doesn't know the account). GitHub's own pages (`/features`, `/topics/...`, `/marketplace/...`...) are checked as regular pages.
- Each run launches one shared Chromium (only if needed) that blocks images, media, fonts and analytics scripts. Links to the same page with different hashes share one fetch or browser navigation, and GitHub API responses are cached for the run. The run metrics (links, unique URLs and pages, requests, navigations, duration per phase) are logged at the end.
