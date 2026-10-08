# Contributing

- Node: `.nvmrc`
- pnpm: `package.json` (`packageManager`)
- `pnpm install`
- Style: [CODING_STANDARDS.md](CODING_STANDARDS.md)
- User docs: [README](README.md), [CLI](docs/cli.md), [Action](docs/action.md)

## Commands

- `pnpm test`. Offline unit tests (`*.test.ts`), mocked network
- `pnpm run test:integration`. Live sites and GitHub API. Needs network, Chromium, `GH_TOKEN` (or `.env`)
- `pnpm run check`. Format, lint, `tsc`, knip (CI minus tests)
- `pnpm run check:fix`. Apply format and safe lint fixes
- `pnpm cli`. Same args as the [CLI](docs/cli.md)
- `pnpm bench`. `bench/bench.ts`
- Fix lint findings. A suppression needs a reason

## Code

- `src/cli.ts`. Commands, run, reports
- `src/website.ts`. `site`
- `src/github/gh_get_links.ts`. `github-org`
- `src/local_files.ts`. `files`
- `src/link.ts`. Shared check pipeline
- `src/fetch_check.ts`, `src/playwright_check.ts`. One link
- `src/github/`. GitHub URL and blob checks
- `src/baseline.ts`. Ignore file
- `src/report/report.tsx`. JSON/HTML report
- `src/github_actions.ts`. Job summary, annotations
- `action.yml`. Reusable action
- How a link is checked is in those files, not here

## This repo

- Daily checks: `.github/workflows/checkLinks.yaml`
- PR sampling and fail-on-broken: `env` comments in that workflow
- Reports: [GitHub Pages](https://fingerprintjs.github.io/docs-link-checker/)
- Action selftest: `.github/workflows/action-selftest.yaml` on `test/action-fixture/`
- `linkcheck.baseline.json` ignores hosts that login-wall or block bots
  - Add a `reason`
  - Do not baseline real broken links
  - Format: [CLI](docs/cli.md#baseline-file)
