import { checkWebsite } from "../src/website";

// The website (blogs mostly) contains a lot of links to news sites and other places
// that make it difficult to check the link programmatically, resulting in a lot of false positives.
// For now, let's just check the links to our own resources and reliable, open sites like GitHub.
(async () => {
  const report = await checkWebsite({
    websiteUrl: "https://fingerprint.com",
    usePlaywright: false,
    linkFilter: (link) =>
      link.href.startsWith("https://dev.fingerprint.com") ||
      link.href.startsWith("https://fingerprint.com") ||
      link.href.startsWith("https://github.com"),
  });

  if (report.summary.totalLinksToFix > 0) {
    // Set FAIL_ON_BROKEN_LINKS=false (e.g. on pull requests) to report broken links without failing.
    if (process.env.FAIL_ON_BROKEN_LINKS === "false") {
      console.warn(
        `Found ${report.summary.totalLinksToFix} links to fix (not failing because FAIL_ON_BROKEN_LINKS=false).`,
      );
    } else {
      process.exit(1);
    }
  }
})();
