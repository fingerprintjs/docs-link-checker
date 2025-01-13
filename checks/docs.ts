import { checkWebsite } from "./../src/website";

(async () => {
  const report = await checkWebsite({
    websiteUrl: "https://dev.fingerprint.com",
    usePlaywright: true,
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.summary.totalLinksToFix > 0) {
    process.exit(1);
  }
})();
