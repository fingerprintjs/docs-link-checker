import { checkReadmesInGithubOrg } from "../src/github/gh_get_links";
import { getLinkCheckExitCode } from "../src/check_run";

(async () => {
  const report = await checkReadmesInGithubOrg("fingerprintjs");
  console.log(JSON.stringify(report, null, 2));
  process.exit(getLinkCheckExitCode(report));
})();
