import { checkWebsite } from "./../src/website";
import { getLinkCheckExitCode } from "../src/check_run";

(async () => {
  const report = await checkWebsite({
    websiteUrl: "https://docs.fingerprint.com",
    usePlaywright: false,
  });
  process.exit(getLinkCheckExitCode(report));
})();
