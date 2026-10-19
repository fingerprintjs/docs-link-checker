# GitHub Action

Check the markdown files of any repository (relative links and anchors on disk, absolute links over the network). Source code files (`src/**/*.tsx`...) are also supported, only their absolute links are checked, see [CLI](cli.md#commands).

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
```

The job summary lists the links to fix, grouped by target, and links to the uploaded reports (HTML and JSON).

| Input            | Default                          | Description                                                                                                         |
| ---------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `files`          | `**/*.md`                        | Globs or paths of markdown or source code files, relative to the repository root, separated by spaces or new lines. |
| `github-token`   | `${{ github.token }}`            | Token used to check GitHub links with the GitHub API.                                                               |
| `fail-on-broken` | `true`                           | Fail the step when links need fixing.                                                                               |
| `baseline`       |                                  | Baseline file, relative to the repository root. See [CLI](cli.md#baseline-file).                                    |
| `sample-rate`    | `1`                              | Check only a deterministic share of the files.                                                                      |
| `annotations`    | `true`                           | Report links to fix as annotations on the files.                                                                    |
| `output-dir`     | `$RUNNER_TEMP/docs-link-checker` | Where to save the JSON and HTML reports.                                                                            |
| `compare`        |                                  | Previous JSON report. The summary adds "+N new, M fixed since previous report".                                     |
| `artifact-name`  | `link-check-report`              | Upload the reports as an artifact with this name and link it in the summary. Empty: no upload.                      |

| Output             | Description                                         |
| ------------------ | --------------------------------------------------- |
| `links-to-fix`     | Number of links to fix, not counting ignored links. |
| `report-path`      | Path of the JSON report.                            |
| `report-html-path` | Path of the HTML report.                            |
| `report-url`       | URL of the uploaded artifact, empty without upload. |

- The action sets up Node.js (the version in this repository's `.nvmrc`) for the rest of the job, and installs its own dependencies with its pinned pnpm through `npx` (the job's own pnpm setup is not changed).
- Artifact names must be unique in a workflow run: set `artifact-name` when the action runs more than once, or `""` to upload nothing.
- Playwright's Chromium is only installed (and cached) when the files contain absolute links.
- To create a baseline for an existing repository, install the [CLI](cli.md) and run it from that repository's root: `docs-link-checker files "**/*.md" --update-baseline`.

## Security

The checker requests every link it finds, including links to private and local addresses (`localhost`, `10.x`, `169.254.169.254`...). Only check documents you trust, or run it where such requests can't reach anything sensitive.

- On pull requests, a fork's workflow already runs the fork's code on the runner, so the checker adds no new access there.
- Only run the action on `pull_request` (not `pull_request_target`), with the default read-only `GITHUB_TOKEN`: `pull_request_target` gives the checked documents a token with write access and the repository's secrets.
