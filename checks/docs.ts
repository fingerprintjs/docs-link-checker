import { checkWebsite } from "./../src/website";

(async () => {
  const report = await checkWebsite({
    websiteUrl: "https://dev.fingerprint.com",
    usePlaywright: false,
  });
  if (report.summary.totalLinksToFix > 0) {
    process.exit(1);
  }
})();
