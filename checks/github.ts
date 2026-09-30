import { checkReadmesInGithubOrg } from "../src/github/gh_get_links";

(async () => {
  const report = await checkReadmesInGithubOrg("fingerprintjs");
  console.log(JSON.stringify(report, null, 2));
  if (report.summary.totalLinksToFix > 0) {
    // Set FAIL_ON_BROKEN_LINKS=false (e.g. on pull requests) to report broken links without failing.
    if (process.env.FAIL_ON_BROKEN_LINKS === "false") {
      console.warn(
        `Found ${report.summary.totalLinksToFix} links to fix (not failing because FAIL_ON_BROKEN_LINKS=false).`
      );
    } else {
      process.exit(1);
    }
  }
})();
