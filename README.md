# Docs link checker

Regular link checkers only look at HTTP status. Docs also use `#anchors` and GitHub `#L3-L5` line links. Those still return 200 after the heading or line is gone.

This checker loads the page and checks that the hash exists. Client-rendered docs are checked in a headless browser.

## CLI

> [!WARNING]
> This repository is private. The CLI only works locally. Clone it, or `npx` from a machine that can access GitHub.

Not on npm. Needs Node.js 24+. Run it from the directory you want to check.

```sh
npx "github:fingerprintjs/docs-link-checker#main" files "**/*.md"
```

```sh
# Website, from its sitemap
docs-link-checker site https://dev.fingerprint.com

# Public READMEs of a GitHub org (needs GH_TOKEN)
docs-link-checker github-org fingerprintjs

# Local markdown
docs-link-checker files "docs/**/*.md" README.md
```

Options, baseline files, and reports: [docs/cli.md](docs/cli.md).

## GitHub Action

> [!WARNING]
> This repository is private. The action only works in this repo with `uses: ./`, or in workflows that can access it.

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

Fingerprint docs, public GitHub READMEs, and fingerprint.com are checked every day. Latest reports: [GitHub Pages](https://fingerprintjs.github.io/docs-link-checker/). Setup: [CONTRIBUTING.md](CONTRIBUTING.md).
