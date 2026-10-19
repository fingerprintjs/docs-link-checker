# Docs link checker (Beta)

> [!WARNING]
> This project is in BETA and heavily AI-assisted. If you have any suggestion at all feel free to open an issue, a PR or shoot a message to @jurouhlar on Slack.

Regular link checkers only look at HTTP status. Docs also use `#anchors` and GitHub `#L3-L5` line links. Those still return 200 after the heading or line is gone.

This checker loads the page and checks that the hash exists. Client-rendered docs are checked in a headless browser.

## What this repo checks

Every day at 03:17 UTC, on every push to main, and on a manual run, [check links](.github/workflows/checkLinks.yaml) checks the three sources below and publishes the reports.

```text
daily 03:17 UTC, push to main, manual
  docs.fingerprint.com
  fingerprintjs READMEs
  fingerprint.com
  reports
    GitHub Pages
    Actions artifacts, 30 days
```

- **docs.fingerprint.com.** Every page from the sitemap. [Report](https://fingerprintjs.github.io/docs-link-checker/docs-fingerprint-com.html).
- **fingerprintjs READMEs.** Public repositories that are still active. [Report](https://fingerprintjs.github.io/docs-link-checker/fingerprintjs-github-readmes.html).
- **fingerprint.com.** Links to docs.fingerprint.com, dev.fingerprint.com, fingerprint.com, and github.com. [Report](https://fingerprintjs.github.io/docs-link-checker/fingerprint-com.html).

[GitHub Pages](https://fingerprintjs.github.io/docs-link-checker/) updates when all three reports exist. If one report is missing, the previous site stays up. The job fails only when the checker crashes or is misconfigured. Workflow setup is in [CONTRIBUTING.md](CONTRIBUTING.md).

## CLI

> [!WARNING]
> This repository is currently private. The CLI only works if the machine can access this repository.

Not on npm. Needs Node.js 24+. Run it from the directory you want to check.

```sh
npx "github:fingerprintjs/docs-link-checker#main" files "**/*.md"
```

```sh
# Website, from its sitemap
docs-link-checker site https://docs.fingerprint.com

# Public READMEs of a GitHub org (needs GH_TOKEN)
docs-link-checker github-org fingerprintjs

# Local markdown
docs-link-checker files "docs/**/*.md" README.md

# Absolute links in source code (JSX hrefs, strings, comments)
docs-link-checker files "src/**/*.tsx"
```

Options, baseline files, and reports: [docs/cli.md](docs/cli.md).

## GitHub Action

> [!WARNING]
> This repository is currently private. The action only works in workflows that can access it (private repos in fingerprintjs org, but not public ones).

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
        with:
          files: |
            README.md
            docs/**/*.md
```

Inputs and outputs: [docs/action.md](docs/action.md).
