# CLI

The package is not published to npm. Install this repository from GitHub. The `bin` field in `package.json` provides the `docs-link-checker` command. Node.js 24 or newer is required.

```sh
# One-off, from the directory to check
npx "github:fingerprintjs/docs-link-checker" --help
npx "github:fingerprintjs/docs-link-checker#main" files "**/*.md"

# Dev dependency, then the bin
pnpm add -D "github:fingerprintjs/docs-link-checker#main"
pnpm exec docs-link-checker files "**/*.md" --update-baseline
```

The first run that needs a browser installs Playwright's Chromium (cached afterwards). Run the command in the directory you want to check. Globs, root-relative links, the baseline file, and the report directory are resolved against the current directory.

In this repository, `pnpm cli` runs the same CLI.

```sh
# All pages of a website (from its sitemap)
docs-link-checker site https://docs.fingerprint.com
# Only links starting with one of the prefixes
docs-link-checker site https://fingerprint.com --include https://fingerprint.com --include https://github.com
# README files of all public, non-archived repositories of a GitHub organization (needs GH_TOKEN)
docs-link-checker github-org fingerprintjs
# Local markdown files
docs-link-checker files "docs/**/*.md" README.md
docs-link-checker files "**/*.md" --dry-run   # only list the links
```

## Commands

- `site <url> [--include <prefix>...]`: links on all pages of the website's sitemap. `--include` (repeatable) keeps only links starting with one of the prefixes.
- `github-org <org>`: links in README files of the organization's public repositories (deprecated repos in `GITHUB_ORG_EXCLUDED_REPOS`, see [CONTRIBUTING](../CONTRIBUTING.md), are skipped).
- `files <glob...> [--dry-run] [--no-annotations]`: links in local markdown files (`.md`, `.markdown`, `node_modules` and `.git` are skipped). Quote the globs so the CLI expands them (`**` works in every shell).
  - Relative links (`docs/a.md`, `../b/`, `a.md?plain=1`) are resolved against the file, root-relative links (`/docs/a.md`) against the current directory. The target file or directory must exist (file names are case-sensitive on Linux, like on GitHub), inside the current directory: links leaving it, also through symlinks, are broken and the file is never read.
  - `#anchors` (`#install`, `docs/a.md#install`, `docs/#install` for the directory's `README.md` or `README.markdown`, in any case, `.md` first) must match a heading slug (GitHub semantics, like for GitHub links) or an HTML anchor (`<a name="...">`). `#L10-L20` on code files must be within the file (lines start at 1, ranges go forward). Other anchors on non-markdown files are not checked.
  - Absolute links (`https://...`) are checked like in the other commands (fetch, GitHub API, Playwright). `mailto:` and other schemes are skipped.
  - Links to fix are printed as one row per problem, `file:line  problem  link  reason`, or as `::error file=...,line=...::` annotations in GitHub Actions (instead of the rows). `--no-annotations` prints neither.
  - In the HTML report, files and relative links are plain text. In GitHub Actions (run from `GITHUB_WORKSPACE`), they link to the checked commit on GitHub (`.../blob/<sha>/docs/a.md#L7`), links leaving the repository are not linked.

## Options

Environment variables are the defaults.

| Option                                    | Environment variable                         | Description                                                                                                                                                                                                                                                                    |
| ----------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--sample-rate <0-1>`                     | `LINK_CHECK_SAMPLE_RATE`                     | Check only a deterministic share of the pages / README files / markdown files. Default `1`.                                                                                                                                                                                    |
| `--fail-on-broken`, `--no-fail-on-broken` | `FAIL_ON_BROKEN_LINKS` (`false` to not fail) | Exit with code 1 when there are links to fix. Default: fail.                                                                                                                                                                                                                   |
| `--baseline <file>`                       | `LINK_CHECK_BASELINE`                        | [Baseline file](#baseline-file) with known false positives and accepted broken links.                                                                                                                                                                                          |
| `--update-baseline`                       |                                              | Add the current failures to the baseline file (default `linkcheck.baseline.json`) and exit with code 0. Existing entries are kept.                                                                                                                                             |
| `--prune-baseline`                        |                                              | With `--update-baseline`: also remove exact entries that no longer fail. Only on a full-scope run (see [Baseline file](#baseline-file)).                                                                                                                                       |
| `--compare <report.json>`                 | `LINK_CHECK_COMPARE`                         | Previous JSON report of the same check. The report gets `diff: { new, fixed }`: links to fix (by page, link and problem) that are new or gone since then. A missing or unreadable file only logs a notice. Don't combine with `--sample-rate`, unchecked pages count as fixed. |
| `--output-dir <dir>`                      |                                              | Where to save the JSON and HTML reports. Default `results`.                                                                                                                                                                                                                    |
| `--verbose`                               |                                              | Also show run metrics, timings of every batch, request retries and GitHub API requests.                                                                                                                                                                                        |
| `--json`                                  |                                              | Print the JSON report to stdout, logs go to stderr.                                                                                                                                                                                                                            |
| `--host-concurrency <n>`                  | `LINK_CHECK_HOST_CONCURRENCY`                | Max concurrent requests per host. Default `8`.                                                                                                                                                                                                                                 |

- `GH_TOKEN` (environment variable or `.env` file) is used to check GitHub links with the API. `github-org` requires it, the other commands fall back to a browser without it.
- Exit codes: `0` no links to fix (or not failing), `1` links to fix or the check crashed, `2` invalid arguments or baseline file.
- The JSON report has `schemaVersion` (`1`), `generatedAt` (ISO time), `durationMs`, the `summary`, the links by group and, with `--compare`, `diff`. Failed and OK links can have `redirectedTo`: the final URL when the link redirected to another page (a trailing slash or hash change is not reported).
- Reports are saved to `<output-dir>/<name>.json` and `.html` (for example `results/docs-fingerprint-com.html`, `results/local-files.html`).
- In GitHub Actions, the CLI appends a summary to `GITHUB_STEP_SUMMARY` and writes the `links-to-fix`, `report-path` and `report-html-path` step outputs to `GITHUB_OUTPUT`.

## Output

```text
docs-link-checker site https://docs.fingerprint.com
Baseline linkcheck.baseline.json, 31 entries

✓ Found 22,000 links in 1,312 pages 1m 3s
✓ Checked 4,120 URLs fetch, GitHub API  3m 12s
✓ Re-checked 214 pages in browser 1m 48s

HTTP 404  developers.facebook.com/documentation/sharing/webmasters/web-crawlers  on 1 page
          ↳ /docs/search-bots-filtering  "source"

✗ 1 link to fix (1 broken)
  22,000 checked · 260 ignored by baseline · 0 could not check · 5m 4s
  Report results/docs-fingerprint-com.html
  False positive? --update-baseline
```

- Steps are printed with their duration. While URLs are checked, a TTY shows one redrawn progress line (count, bar, ETA, failures so far), other outputs get a line every 10%.
- `files` lists one row per problem, grouped by file. `site` and `github-org` group links to fix by target, with the pages (without the site's origin) and link texts below it, up to 5 pages per target. A link that redirected shows `redirects to <url>`.
- With `--compare`, the verdict is followed by `+<new> new, <fixed> fixed since previous report`.
- Colors follow `NO_COLOR` and `FORCE_COLOR`, and are off when the output is not a TTY. With `--json`, all of this goes to stderr.
- `--verbose` adds the run metrics and timings.

## Baseline file

A baseline (ignore) file lists known false positives and accepted broken links. Failing links that match an entry are reported in a separate "ignored" section of the report and don't count towards `totalLinksToFix` (they don't fail the run). The HTML report puts ignored links that share a target, error, status, and reason on one row, and lists the occurrences under it. A relative link is resolved against the file it is in.

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

The checker requests every link it finds, including links to private and local addresses (`localhost`, `10.x`, `169.254.169.254`...). Only check documents you trust, or run it where such requests can't reach anything sensitive.

## Limitations

This is an internal prototype.

- Fingerprint.com is only checked for links to our resources and GitHub, external links trigger too many false positives for now.
- Link [text fragments](https://developer.mozilla.org/en-US/docs/Web/URI/Fragment/Text_fragments) are not checked.
- GitHub `#L{number}` links are only checked against the number of lines of the file (not, e.g., whether the line still shows what the link meant).
- Code quality, test coverage and CI does not meet production standards.
