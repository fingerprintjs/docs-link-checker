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
- `src/sources/`. Where links come from: `website.ts` (`site`), `local_files.ts` (`files`)
- `src/github/get_links.ts`. `github-org`
- `src/check/`. Checking links: `link.ts` shared pipeline, `fetch_check.ts`, `playwright_check.ts` one link, `verdict.ts` what a response means (result, retry, browser re-check)
- `src/github/`. GitHub URL and blob checks
- `src/baseline.ts`. Ignore file
- `src/report/`. JSON/HTML report, CLI output, GitHub Actions job summary and annotations
- `action.yml`. Reusable action
- How a link is checked is in those files, not here

## This repo

- Daily checks: `.github/workflows/checkLinks.yaml`
- PR sampling: `LINK_CHECK_SAMPLE_RATE` in `.github/workflows/checkLinks.yaml` (full run on main/schedule)
- Reports: [GitHub Pages](https://fingerprintjs.github.io/docs-link-checker/)
- Slack: the `notify` job posts new broken links and [weekly reminders](docs/cli.md#reminders) to #integrations-notifications, through the incoming webhook in the `SLACK_WEBHOOK_URL` secret. The message is built in `src/report/slack.ts`.
- Action selftest: `.github/workflows/action-selftest.yaml` on `src/__fixtures__/action/`
- Pull requests from forks get no secrets. CI uses the workflow token instead of the GitHub App token, and the benchmark writes only the job summary, not the PR comment.
- `linkcheck.baseline.json` ignores hosts that login-wall or block bots
  - Add a `reason`
  - Do not baseline real broken links
  - Format: [CLI](docs/cli.md#baseline-file)
- `github-org` skips deprecated repos listed in `GITHUB_ORG_EXCLUDED_REPOS` (`src/github/get_links.ts`)
