# Documentation link checker 

A GitHub workflow that checks for broken links in our documentation, public GitHub readmes, and our website.

* Run periodically every day.
* You can start the workflow manually from inside [**Actions**](https://github.com/fingerprintjs/docs-link-checker/actions/workflows/checkLinks.yaml).
* Failed runs send a notification to the `#integrations-notifications` Slack channel. Once we fix all links and stabilize the workflow, we can send the notification to the `#documentation` channel.
* The latest results are deployed to [GitHub pages](https://fingerprintjs.github.io/docs-link-checker/) of this repository (only from `main` and manual runs, never from pull requests).
* On pull requests, the link checks still run end to end, but broken links do not fail the check (`FAIL_ON_BROKEN_LINKS=false`). They only fail if the checker itself crashes. On `main` and manual runs, broken links fail the run.

## Development

* Node.js version is defined in `.nvmrc`, pnpm version in the `packageManager` field of `package.json` (use `corepack enable` or install the matching pnpm).
* `pnpm install`, `pnpm run tsc`, `pnpm test` (single run) or `pnpm run test:watch`. Tests and link checks need a `GH_TOKEN` environment variable.
* Link checks (`pnpm run checkLinks:docs`, `checkLinks:github`, `checkLinks:web`) exit with code 1 when broken links are found. Set `FAIL_ON_BROKEN_LINKS=false` to only report them.

## Limitations

> [!WARNING]  
> While useful, this is still just an internal prototype and a work in progress. 

* Fingerprint.com is only checked for links to our resources and GitHub, external links trigger too many false positives for now.
* Link [text fragments](https://developer.mozilla.org/en-US/docs/Web/URI/Fragment/Text_fragments) are not checked.
* Code quality, test coverage and CI does not meet production standards.
* Github `#L{number}` links still cause false positives sometimes.

## Motivation

There are obviously many libraries and services (we also use a weekly check by [TripleChecker.com](https://www.triplechecker.com/)) to check for broken links but I haven't found one that works well for documentation. They all just check the link's response status code and call it a day.

But documentation often contains **hash/anchor** links like [https://dev.fingerprint.com/docs/quick-start-guide#1-create-an-account](https://dev.fingerprint.com/docs/quick-start-guide#1-create-an-account) that point to specific sections of a page.

These link can be broken despite returning `200 OK`. Hash links break far more easily that normal links: sub-headlines can change over time and there is usually no warning or redirect mechanism applied.

So a proper documentation link checker must:  
* Parse the returned page and check that hash element actually exists on the page. This must also work for common edge cases like: 
  * Client-side rendered pages (a headless browser is needed).
  * GitHub links pointing to specific lines in the code, like [https://github.com/fingerprintjs/fingerprintjs/blob/master/package.json#L3-L5](https://github.com/fingerprintjs/fingerprintjs/blob/master/package.json#L3-L5)
* Be able to run on-demand so you can change a subtitle and check right away if that breaks any links across all our resources.

## To-do

- [x] Combine artifact outputs
- [x] Deploy to GitHub pages
- [x] Enable Slack notifications
- [x] Nicer Readme
- [x] Clean up promise pool
- [x] Run tests in CI
- [ ] Fix Github `#L{number}` links occasional false positives 
- [ ] Add more tests for everything
- [ ] Nicer report styling
- [ ] Add `eslint`/`biome`
- [ ] Copy link to clipboard in the report 
- [ ] Improve performance
- [ ] Provide a reusable GitHub action for checking `.md` files from inside a repository.
- [ ] Make progress bar actually display progress inside GitHub actions UI
- [ ] Improve API and documentation to make this potentially releasable on NPM as a utility package


