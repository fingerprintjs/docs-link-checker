// Skeleton: the titles of main's tests, to port with the new design (STEP 2, CLI group).
import { describe, it } from "vitest";

describe("formatFileProblems()", () => {
  it.todo("prints one line per link to fix, collapsing and shortening error details");
});
describe("runCli()", () => {
  describe("arguments and options", () => {
    it.todo(
      "--sample-rate limits the checked files, LINK_CHECK_SAMPLE_RATE is the default and flags win",
    );
    it.todo("FAIL_ON_BROKEN_LINKS=false and --no-fail-on-broken only report links to fix");
    it.todo("LINK_CHECK_BASELINE is the default baseline file");
    it.todo(
      "--update-baseline writes the default baseline file and reads a relative --baseline in io.cwd, not process.cwd()",
    );
    it.todo("rejects %j with exit code 2");
    it.todo("rejects invalid environment variables when they are used (exit code 2)");
    it.todo("ignores invalid environment variables for --help and for flags that override them");
    it.todo("prints help for help, --help and <command> --help to stdout");
  });
  it.todo("files: prints problems with lines, writes reports and outputs, fails on links to fix");
  it.todo("files: emits annotations in GitHub Actions, and passes with --no-fail-on-broken");
  it.todo("files: links local files to the checked commit in the HTML report in GitHub Actions");
  it.todo("files --json: prints only the JSON report to stdout");
  it.todo("files --dry-run: lists links without checking them");
  it.todo("files: returns 1 when no file matches");
  it.todo("baseline: ignores matching links, --update-baseline writes failures and passes");
  it.todo(
    "baseline: --update-baseline on a partial scope keeps entries of other files, --prune-baseline drops them",
  );
  it.todo("baseline: returns 2 with a clear message for an invalid file");
  it.todo(
    "site: checks the sitemap pages, --include (repeatable) filters links, reports links to fix, applies the baseline",
  );
  it.todo("github-org: passes the organization and sample rate, names the report");
  it.todo("returns 1 when the check crashes");
});
