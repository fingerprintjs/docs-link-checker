# GitHub Action

Check the markdown files of any repository (relative links and anchors on disk, absolute links over the network).

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
| `baseline`       |                                  | Baseline file, relative to the repository root. See [CLI](cli.md#baseline-file).                     |
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
- To create a baseline for an existing repository, install the [CLI](cli.md) and run it from that repository's root: `docs-link-checker files "**/*.md" --update-baseline`.

## Security

The checker requests every link it finds, including links to private and local addresses (`localhost`, `10.x`, `169.254.169.254`...). Only check documents you trust, or run it where such requests can't reach anything sensitive.

- On pull requests, a fork's workflow already runs the fork's code on the runner, so the checker adds no new access there.
- Only run the action on `pull_request` (not `pull_request_target`), with the default read-only `GITHUB_TOKEN`: `pull_request_target` gives the checked documents a token with write access and the repository's secrets.
