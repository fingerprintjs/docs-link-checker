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
- On pull requests, the link checks still run end to end on a 10% sample of pages (`LINK_CHECK_SAMPLE_RATE=0.1`), but broken links do not fail the check (`FAIL_ON_BROKEN_LINKS=false`). They only fail if the checker itself crashes. On `main` and manual runs, broken links fail the run.
- Every job writes a summary (counts and the first 50 links to fix) to the GitHub job summary.

## CLI

The package is not published to npm. Install this repository from GitHub. The `bin` field in `package.json` provides the `docs-link-checker` command. Node.js 24 or newer is required.

Pin a commit or tag. Without one, the install follows `main`.

```sh
# One-off, from the directory to check
npx "github:fingerprintjs/docs-link-checker#<commit-or-tag>" --help
npx "github:fingerprintjs/docs-link-checker#<commit-or-tag>" files "**/*.md"

# Dev dependency, then the bin
pnpm add -D "github:fingerprintjs/docs-link-checker#<commit-or-tag>"
pnpm exec docs-link-checker files "**/*.md" --update-baseline
```

The install also installs Playwright, which downloads its browsers. Run the command in the directory you want to check. Globs, root-relative links, the baseline file, and the report directory are resolved against the current directory.

In this repository, `pnpm cli` runs the same CLI.

```sh
# All pages of a website (from its sitemap)
docs-link-checker site https://dev.fingerprint.com
# Only links starting with one of the prefixes
docs-link-checker site https://fingerprint.com --include https://fingerprint.com --include https://github.com
# README files of all public, non-archived repositories of a GitHub organization (needs GH_TOKEN)
docs-link-checker github-org fingerprintjs
# Local markdown files
docs-link-checker files "docs/**/*.md" README.md
docs-link-checker files "**/*.md" --dry-run   # only list the links
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
- Every request and every redirect hop is checked: IP literals and `localhost` names before sending, other host names when connecting (the DNS lookup of the connection fails if any resolved address is non-public, so DNS rebinding does not work). A blocked link is reported as "could not check" ("Destination not allowed (private or local address)"). It doesn't count as a link to fix and is never requested.
- The fetch pass is the primary guard. Links it blocks are never re-checked in the browser. Playwright only re-checks links that passed it, and additionally aborts requests (navigation, redirects, page resources) to blocked IP literals and localhost names, without resolving names.
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
- To create a baseline for an existing repository, install the [CLI](#cli) and run it from that repository's root: `docs-link-checker files "**/*.md" --update-baseline`.

## Contributing

Setup, tests, and how checks run are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Benchmark

- `bench/corpus.json` is a static 8% sample (6,812 links) of real links from dev.fingerprint.com, fingerprint.com and the fingerprintjs org READMEs. Replace it by hand if needed, it is a JSON array of `{ page, href, text }`.
- `pnpm bench` times one round on the current tree. `pnpm bench --base <dir>` compares against another checkout (e.g. `git worktree add base-checkout origin/main`, then `pnpm install` in it), `--rounds <n>` sets rounds per side (default 2 with `--base`, 1 without).
- Each round is its own process, base and head of a round run at the same time, rounds run one after another. The report shows median and min-max of total time, phase times and run counters.
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
