import { checkWebsite } from "./../src/website";

(async () => {
  const report = await checkWebsite({
    websiteUrl: "https://dev.fingerprint.com",
    usePlaywright: false,
  });
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
