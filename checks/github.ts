import { checkReadmesInGithubOrg } from "../src/sources/githubUtils";

(async () => {
  const report = await checkReadmesInGithubOrg("fingerprintjs");
  console.log(JSON.stringify(report, null, 2));
  if (report.summary.totalLinksToFix > 0) {
    process.exit(1);
  }
})();
