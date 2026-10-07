# Documentation link checker

Checks for broken links, including `#anchor` links, in documentation. It comes as:

- A GitHub workflow that checks our documentation, public GitHub readmes, and our website (see below).
- A [CLI](#cli) to check websites, GitHub organizations or local markdown files.
- A [reusable GitHub Action](#github-action) to check markdown files in any repository.

## Our workflow

- Runs every day at 03:17 UTC, on pushes to `main` and on pull requests.
- You can start the workflow manually from inside [**Actions**](https://github.com/fingerprintjs/docs-link-checker/actions/workflows/checkLinks.yaml).
- Slack notifications for failed runs are disabled for now (the `report-status` job in `checkLinks.yaml` is commented out). Once we fix all links and stabilize the workflow, we can re-enable them and send them to the `#documentation` channel.
- The latest results are deployed to [GitHub pages](https://fingerprintjs.github.io/docs-link-checker/) of this repository (only from `main` and manual runs, never from pull requests).
- On pull requests, the link checks still run end to end (on a 10% sample of pages, see `LINK_CHECK_SAMPLE_RATE` below), but broken links do not fail the check (`FAIL_ON_BROKEN_LINKS=false`). They only fail if the checker itself crashes. On `main` and manual runs, broken links fail the run.
- Every job writes a summary (counts and the first 50 links to fix) to the GitHub job summary.

## CLI

```sh
pnpm install
pnpm cli --help                      # or: pnpm exec tsx src/cli.ts --help, or the `docs-link-checker` bin

# All pages of a website (from its sitemap)
pnpm cli site https://dev.fingerprint.com
# Only links starting with one of the prefixes
pnpm cli site https://fingerprint.com --include https://fingerprint.com --include https://github.com
# README files of all public, non-archived repositories of a GitHub organization (needs GH_TOKEN)
pnpm cli github-org fingerprintjs
# Local markdown files
pnpm cli files "docs/**/*.md" README.md
pnpm cli files "**/*.md" --dry-run   # only list the links
```

Commands:

- `site <url> [--include <prefix>...]`: links on all pages of the website's sitemap. `--include` (repeatable) keeps only links starting with one of the prefixes.
- `github-org <org>`: links in README files of the organization's public repositories.
- `files <glob...> [--dry-run] [--no-annotations]`: links in local markdown files (`.md`, `.markdown`, `node_modules` and `.git` are skipped). Quote the globs so the CLI expands them (`**` works in every shell).
  - Relative links (`docs/a.md`, `../b/`, `a.md?plain=1`) are resolved against the file, root-relative links (`/docs/a.md`) against the current directory. The target file or directory must exist (file names are case-sensitive on Linux, like on GitHub), inside the current directory: links leaving it, also through symlinks, are broken and the file is never read.
  - `#anchors` (`#install`, `docs/a.md#install`, `docs/#install` for the directory's `README.md` or `README.markdown`, in any case, `.md` first) must match a heading slug (GitHub semantics, like for GitHub links) or an HTML anchor (`<a name="...">`). `#L10-L20` on code files must be within the file (lines start at 1, ranges go forward). Other anchors on non-markdown files are not checked.
  - Absolute links (`https://...`) are checked like in the other commands (fetch, GitHub API, Playwright). `mailto:` and other schemes are skipped.
  - Links to fix are printed as `file:line: link: error`, and as `::error file=...,line=...::` annotations in GitHub Actions.
  - In the HTML report, files and relative links are plain text. In GitHub Actions (run from `GITHUB_WORKSPACE`), they link to the checked commit on GitHub (`.../blob/<sha>/docs/a.md#L7`), links leaving the repository are not linked.

Common options (environment variables are the defaults):

| Option                                    | Environment variable                         | Description                                                                                                                                      |
| ----------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--sample-rate <0-1>`                     | `LINK_CHECK_SAMPLE_RATE`                     | Check only a deterministic share of the pages / README files / markdown files. Default `1`.                                                      |
| `--fail-on-broken`, `--no-fail-on-broken` | `FAIL_ON_BROKEN_LINKS` (`false` to not fail) | Exit with code 1 when there are links to fix. Default: fail.                                                                                     |
| `--baseline <file>`                       | `LINK_CHECK_BASELINE`                        | [Baseline file](#baseline-file) with known false positives and accepted broken links.                                                            |
| `--update-baseline`                       |                                              | Add the current failures to the baseline file (default `linkcheck.baseline.json`) and exit with code 0. Existing entries are kept.               |
| `--prune-baseline`                        |                                              | With `--update-baseline`: also remove exact entries that no longer fail. Only on a full-scope run (see [Baseline file](#baseline-file)).         |
| `--output-dir <dir>`                      |                                              | Where to save the JSON and HTML reports. Default `results`.                                                                                      |
| `--json`                                  |                                              | Print the JSON report to stdout, logs go to stderr.                                                                                              |
| `--host-concurrency <n>`                  | `LINK_CHECK_HOST_CONCURRENCY`                | Max concurrent requests per host. Default `8`.                                                                                                   |
| `--allow-private-hosts`                   | `LINK_CHECK_ALLOW_PRIVATE_HOSTS=true`        | Allow links to private and local addresses, blocked by default (see [Security](#security)). Only for trusted documents, e.g. a local dev server. |

- `GH_TOKEN` (environment variable or `.env` file) is used to check GitHub links with the API. `github-org` requires it, the other commands fall back to a browser without it.
- Exit codes: `0` no links to fix (or not failing), `1` links to fix or the check crashed, `2` invalid arguments or baseline file.
- Reports are saved to `<output-dir>/<name>.json` and `.html` (for example `results/dev-fingerprint-com.html`, `results/local-files.html`).
- In GitHub Actions, the CLI appends a summary to `GITHUB_STEP_SUMMARY` and writes the `links-to-fix`, `report-path` and `report-html-path` step outputs to `GITHUB_OUTPUT`.

## Baseline file

A baseline (ignore) file lists known false positives and accepted broken links. Failing links that match an entry are reported in a separate "ignored" section of the report and don't count towards `totalLinksToFix` (they don't fail the run).

```json
{
  "ignore": [
    { "href": "https://example.com/flaky-page", "page": "docs/guide.md", "reason": "Blocks bots" },
    { "pattern": "https://www.linkedin.com/**", "reason": "Always asks for a login" },
    "https://twitter.com/**",
    "https://*.x.com/**"
  ]
}
```

- Every entry has exactly one of:
  - `href`: the exact link, as reported (the resolved URL for websites and GitHub, the link as written for local files).
  - `pattern`: a glob. `**` matches anything, `*` anything except `/`, everything else (including `?`, `.`, `+`, `(`, `[`) is literal. A pattern ending with `/**` also matches what comes before it: `https://example.com/**` matches `https://example.com` (no trailing slash) too. A plain string entry is a shorthand for `{ "pattern": "..." }`. At most 2048 characters.
- `page` (optional): only ignore the link on this page (an exact value or a glob, for example `docs/**`).
- `reason` (optional): shown in the report.
- Regular expressions are not supported on purpose (a `regex` key is rejected): the file is user input, and a pattern like `(a+)+$` could make the check hang ([ReDoS](https://owasp.org/www-community/attacks/Regular_expression_Denial_of_Service_-_ReDoS)). Globs are matched without regular expressions, in linear time.
- A bare array of entries works too. Unknown keys and invalid entries fail with a message pointing to the entry (exit code `2`).
- `--update-baseline` adds new failures as `{ "href", "page" }` entries (add a `reason` by hand) and keeps every existing entry: a run can check only part of what a shared baseline covers (`files docs/*.md`, `site --include`, sampling), so entries of other files are never lost.
- `--update-baseline --prune-baseline` also removes exact `href` entries that no longer match a failure (fixed links), `pattern` entries are always kept. Only use it on a run that checks everything the baseline covers (all files and pages, no sampling, the CLI refuses it with `--sample-rate` below 1).

## Security

Links can come from untrusted documents, for example markdown changed in a pull request that the [GitHub Action](#github-action) checks. So the checker never sends requests to non-public destinations (SSRF protection):

- Blocked: loopback (`127.0.0.0/8`, `::1`), unspecified (`0.0.0.0/8`, `::`), private (`10/8`, `172.16/12`, `192.168/16`), link-local (`169.254/16` incl. cloud metadata `169.254.169.254`, `fe80::/10`), CGNAT (`100.64/10`), unique local (`fc00::/7`), multicast, reserved ranges, their IPv4-mapped IPv6 forms, and `localhost` / `*.localhost`.
- IPv4-compatible (`::a.b.c.d`), IPv4-translated (`::ffff:0:a.b.c.d`), NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`) forms are blocked wholesale, public addresses in these forms too: docs never link to them.
- Every request and every redirect hop is checked: IP literals directly, host names by resolving them and blocking if any address is non-public. A blocked link is reported as "could not check" ("Destination not allowed (private or local address)"). It doesn't count as a link to fix and is never requested.
- The fetch pass is the primary guard. Links it blocks are never re-checked in the browser. Playwright only re-checks links that passed it, and additionally aborts requests (navigation, redirects, page resources) to blocked IP literals and localhost names, without resolving names.
- Limitation: `fetch` resolves the name again when connecting, so DNS rebinding (a name that answers with a public address first and a private one right after) is not prevented.
- The action always blocks private destinations. Locally, `--allow-private-hosts` (or `LINK_CHECK_ALLOW_PRIVATE_HOSTS=true`) allows them, e.g. to check a dev server on `localhost`. Only use it with trusted documents.
- Only run the action on `pull_request` (not `pull_request_target`), with the default read-only `GITHUB_TOKEN`: the checked documents come from the pull request.

## GitHub Action

Check the markdown files of any repository (relative links and anchors on disk, absolute links over the network):

```yaml
# .github/workflows/links.yaml
name: Check links
on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  links:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: fingerprintjs/docs-link-checker@main
        id: links
        with:
          files: |
            README.md
            docs/**/*.md
          baseline: linkcheck.baseline.json
      - name: Upload report
        if: ${{ !cancelled() && steps.links.outputs.report-html-path }}
        uses: actions/upload-artifact@v7
        with:
          name: link-check-report
          path: ${{ steps.links.outputs.report-html-path }}
```

| Input            | Default                          | Description                                                                                          |
| ---------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `files`          | `**/*.md`                        | Globs or paths of markdown files, relative to the repository root, separated by spaces or new lines. |
| `github-token`   | `${{ github.token }}`            | Token used to check GitHub links with the GitHub API.                                                |
| `fail-on-broken` | `true`                           | Fail the step when links need fixing.                                                                |
| `baseline`       |                                  | Baseline file, relative to the repository root.                                                      |
| `sample-rate`    | `1`                              | Check only a deterministic share of the files.                                                       |
| `annotations`    | `true`                           | Report links to fix as annotations on the files.                                                     |
| `output-dir`     | `$RUNNER_TEMP/docs-link-checker` | Where to save the JSON and HTML reports.                                                             |

| Output             | Description                                         |
| ------------------ | --------------------------------------------------- |
| `links-to-fix`     | Number of links to fix, not counting ignored links. |
| `report-path`      | Path of the JSON report.                            |
| `report-html-path` | Path of the HTML report.                            |

- The action sets up Node.js (the version in this repository's `.nvmrc`) for the rest of the job, and installs its own dependencies with its pinned pnpm through `npx` (the job's own pnpm setup is not changed).
- Playwright's Chromium is only installed (and cached) when the files contain absolute links.
- To create a baseline for an existing repository, run the CLI from its root directory with a local clone of this repository (after `pnpm install` in the clone): `node ../docs-link-checker/bin/docs-link-checker.js files "**/*.md" --update-baseline`. Globs and root-relative links are resolved against the current directory.
- `.github/workflows/action-selftest.yaml` tests the action (`uses: ./`) on the offline fixture in `test/action-fixture/`.

## Development

- Node.js version is defined in `.nvmrc` (and `engines.node`), pnpm version in the `packageManager` field of `package.json` (use `corepack enable` or install the matching pnpm).
- The project is ESM (`"type": "module"`). TypeScript runs directly with `tsx` (link checks) and vitest (tests), `tsc` only type-checks.
- `pnpm install`, `pnpm run tsc`, `pnpm test` (single run) or `pnpm run test:watch`.

* Format with [oxfmt](https://oxc.rs/docs/guide/usage/formatter) (`.oxfmtrc.json`, also sorts imports) and lint with [oxlint](https://oxc.rs/docs/guide/usage/linter) (`.oxlintrc.jsonc`). The linter runs type-aware rules (floating promises, `any` leaks, unsafe type assertions, deprecated APIs), limits function complexity (`sonarjs/cognitive-complexity`, max 20), and bans skipped and focused tests. Warnings fail too.
  - `pnpm run check` runs everything CI runs except tests: formatter check, linter, suppression check, `tsc` and [knip](https://knip.dev/) (unused files, exports and dependencies).
  - `pnpm run check:fix` formats and applies safe lint fixes, `pnpm run lint` only lints, `pnpm run format` only formats.
  - Fix findings instead of suppressing them. A suppression (`// oxlint-disable-next-line rule -- reason`) needs a reason, and their number is capped (`pnpm run lint:suppressions`, `checks/lint_suppressions.ts`).

- `pnpm test` runs offline unit tests (`*.test.ts`). They mock `fetch`, the GitHub API and Playwright, and need no network or `GH_TOKEN`.

* `pnpm run test:coverage` runs them with coverage (CI). It fails when coverage drops below the thresholds in `vitest.config.js`.

- `pnpm run test:integration` runs integration tests (`*.integration.test.ts`) against real websites and the GitHub API. They need network access, Playwright's Chromium and a `GH_TOKEN` environment variable.
- The package scripts used by the workflow (`pnpm run checkLinks:docs`, `checkLinks:github`, `checkLinks:web`) run the [CLI](#cli) (`site` and `github-org` commands), `pnpm run checkLinks:files` checks this README. They need a `GH_TOKEN` environment variable (can also be set in a `.env` file). They exit with code 1 when broken links are found. Set `FAIL_ON_BROKEN_LINKS=false` to only report them. The `site` and `github-org` scripts use the [baseline file](#baseline-file) `linkcheck.baseline.json` at the repository root: it ignores links on hosts that require a login or block automated clients (they would always be "could not check"). Add hosts there with a `reason`, never real broken links.

* Code map: `src/cli.ts` (CLI), `src/website.ts` (`site`), `src/github/gh_get_links.ts` (`github-org`), `src/local_files.ts` (`files`), `src/link.ts` (`checkLinks`, the shared checking pipeline), `src/fetch_check.ts` and `src/playwright_check.ts` (single link checks), `src/baseline.ts`, `src/report/report.tsx` (JSON and HTML reports), `src/github_actions.ts` (job summary, annotations, step outputs), `action.yml` (reusable action).

- Set `LINK_CHECK_SAMPLE_RATE` (a number between `0` and `1`, default `1`) to check only a part of the pages (website sitemap pages, GitHub README files). The sample is deterministic (pages are sorted, then every Nth page is picked) and has at least one page. On pull requests, the workflow uses `LINK_CHECK_SAMPLE_RATE=0.1` to keep CI fast. On `main` and manual runs, it checks everything.
- Set `LINK_CHECK_HOST_CONCURRENCY` (a positive integer, default `8`) to change the maximum number of concurrent `fetch` requests to a single host. It applies to every `fetch` request of a run (sitemaps, source pages, README downloads, link checks), and to every redirect hop (limited by the host it goes to). A `429` response with `Retry-After` pauses requests to that host, and the request is retried. Sitemaps are also limited to 5 concurrent fetches overall. GitHub API requests are limited by Octokit instead, and Playwright navigations by the browser's page limit.
- A `502`, `503` or `504` (an overloaded server, github.com also returns `503` under load) is retried twice, after 2s and 5s, or after `Retry-After` if it asks for longer (at most 10s, a longer `Retry-After` is not waited for). Like a `429`, the retry pauses all requests to that host, Playwright navigations included. If the error persists (also in the browser), the link is reported as "could not check" with the status, not as broken. The wait adds at most 20s per request or navigation. GitHub API requests are retried by Octokit (3 times on 5xx), a persisting server error is re-checked with Playwright.
- Links without a hash are checked with `HEAD`. Any failed `HEAD` response (except `429`) falls back to `GET`: some servers refuse `HEAD` and some answer it differently (support.google.com and chatgpt.com return `404` to `HEAD` and `200` to `GET`). `HEAD` itself is never retried on a server error (502/503/504); the `GET` fallback gets the normal retry policy.
- Hashes not found in the server HTML are checked in Chromium: all links to the same page share one navigation, and the anchors of all of them are waited for in parallel, 15 seconds in total per page (client-side rendered docs like Mintlify and the Terraform Registry add some anchors late, even after the page looks idle). Anchors that appear earlier return right away, a missing anchor takes the whole 15 seconds. Anchors still missing then (the page might render content per hash, like SPA tabs) are retried one by one: the hash is set in the same page and the anchor is waited for up to 3 more seconds. Text fragments (`:~:`), `#/` and Google Help accordion states (`#zippy=...` on support.google.com) are accepted without an element.
- GitHub code line links (`#L12`, `#L12-L15`, with columns `#L12C5-L15C1`, on `github.com/<owner>/<repo>/blob/...`) are checked with the GitHub API, not in the browser (github.com refuses blob pages to headless browsers on CI runners with `503`): the file is read once per run (files over 1 MB with the blob API) and its last linked line must be in the file (lines start at 1, ranges go forward, `#L0` is invalid, a trailing newline does not count as a line, binary files have no lines). On a rendered markdown file (without `?plain=1`), a heading slug like `l12` is accepted too. Branch and tag names with slashes (`blob/feature/x/src/a.ts`, any number of segments, also in `tree/...` links) are resolved when the first segment is not a ref with the file: the branches and tags starting with it are listed once per repository and first segment (cached for the run), the longest one the URL starts with is the ref. A missing file or repository (`404`, also private repositories the token can't see, or `410` Gone) is a broken link. If the API can't answer (no `GH_TOKEN`, a bad token `401`, `403` (rate limited after Octokit's retry, or no access), `429`, server or network errors), the link falls back to the browser, which checks the line numbers of the rendered code view (a persisting `503` there is "could not check").
- GitHub URLs are decoded before they are passed to the GitHub API (tags like `%40scope%2Fpkg%401.0.0`), and `https://github.com/<owner>` is checked as a user or organization (and as a page if the API doesn't know the account). GitHub's own pages (`/features`, `/topics/...`, `/marketplace/...`...) are checked as regular pages.
- Each run launches one shared Chromium (only if needed) that blocks images, media, fonts and analytics scripts. Links to the same page with different hashes share one fetch or browser navigation, and GitHub API responses are cached for the run. The run metrics (links, unique URLs and pages, requests, navigations, duration per phase) are logged at the end.

## Benchmark

- `bench/corpus.json` is a static 8% sample (6,812 links) of real links from dev.fingerprint.com, fingerprint.com and the fingerprintjs org READMEs. Replace it by hand if needed, it is a JSON array of `{ page, href, text }`.
- `pnpm bench` times one round on the current tree. `pnpm bench --base <dir>` compares against another checkout (e.g. `git worktree add base-checkout origin/main`, then `pnpm install` in it), `--rounds <n>` sets rounds per side (default 2 with `--base`, 1 without).
- Each round is its own process, base and head of a round run at the same time, rounds run one after another. The report shows median and min-max of total time, phase times, run counters and the number of link results by outcome (`result: ok`, `result: hash not found`...), to see if a speed change altered results.
- On every PR, CI posts the report as one PR comment (updated on each push). The headline is 🟢/🔴/⚪ on total time: worse or better only if the median differs by more than 15% and 5s. Counters are worse or better only if the base and head min-max ranges do not overlap. A slowdown never fails the PR.

## Limitations

> [!WARNING]  
> While useful, this is still just an internal prototype and a work in progress.

- Fingerprint.com is only checked for links to our resources and GitHub, external links trigger too many false positives for now.
- Link [text fragments](https://developer.mozilla.org/en-US/docs/Web/URI/Fragment/Text_fragments) are not checked.
- Code quality, test coverage and CI does not meet production standards.
- GitHub `#L{number}` links are only checked against the number of lines of the file (not, e.g., whether the line still shows what the link meant).

## Motivation

There are obviously many libraries and services (we also use a weekly check by [TripleChecker.com](https://www.triplechecker.com/)) to check for broken links but I haven't found one that works well for documentation. They all just check the link's response status code and call it a day.

But documentation often contains **hash/anchor** links like [https://dev.fingerprint.com/docs/quick-start-guide#1-create-an-account](https://dev.fingerprint.com/docs/quick-start-guide#1-create-an-account) that point to specific sections of a page.

These link can be broken despite returning `200 OK`. Hash links break far more easily that normal links: sub-headlines can change over time and there is usually no warning or redirect mechanism applied.

So a proper documentation link checker must:

- Parse the returned page and check that hash element actually exists on the page. This must also work for common edge cases like:
  - Client-side rendered pages (a headless browser is needed).
  - GitHub links pointing to specific lines in the code, like [https://github.com/fingerprintjs/fingerprintjs/blob/master/package.json#L3-L5](https://github.com/fingerprintjs/fingerprintjs/blob/master/package.json#L3-L5)
- Be able to run on-demand so you can change a subtitle and check right away if that breaks any links across all our resources.

## To-do

- [x] Combine artifact outputs
- [x] Deploy to GitHub pages
- [ ] Re-enable Slack notifications (disabled until the links are fixed and the workflow is stable)
- [x] Nicer Readme
- [x] Clean up promise pool
- [x] Run tests in CI
- [x] Fix GitHub `#L{number}` links occasional false positives (checked with the GitHub API)
- [ ] Add more tests for everything
- [ ] Nicer report styling
- [x] Add a linter and a formatter (oxlint, oxfmt)
- [x] Copy link to clipboard in the report
- [x] Improve performance
- [x] Upgrade dependencies (0 `pnpm audit` vulnerabilities)
- [x] Provide a reusable GitHub action for checking `.md` files from inside a repository.
- [ ] Make progress bar actually display progress inside GitHub actions UI (the job summary covers the results for now)
- [x] Improve API and documentation (CLI, options for sampling, baselines and the output directory)
- [x] Baseline file for known false positives and accepted broken links
- [ ] Release on npm and the GitHub Marketplace (build to JavaScript instead of running TypeScript with `tsx`, versioned tags for the action)
- [ ] Check links in HTML (`<a href>`) and images in local markdown files
