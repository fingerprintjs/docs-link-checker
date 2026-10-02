import { checkGitHubRateLimit, getMyOctokit } from "../src/github/github_client";

const result = await checkGitHubRateLimit(getMyOctokit());
if (result.remaining < 200) {
  console.error(
    "Few requests left. Checks are likely to hit rate limit resulting in false positives.",
  );
  console.info(`Wait for ${result.resetsIn} and run this again.`);
  process.exit(1);
}
