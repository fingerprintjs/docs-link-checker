import { checkWebsite } from "../src/website";
import { getLinkCheckExitCode } from "../src/check_run";

// The website (blogs mostly) contains a lot of links to news sites and other places
// that make it difficult to check the link programmatically, resulting in a lot of false positives.
// For now, let's just check the links to our own resources and reliable, open sites like GitHub.
(async () => {
  const report = await checkWebsite({
    websiteUrl: "https://fingerprint.com",
    usePlaywright: false,
    linkFilter: (link) =>
      link.href.startsWith("https://docs.fingerprint.com") ||
      link.href.startsWith("https://fingerprint.com") ||
      link.href.startsWith("https://github.com"),
  });

  process.exit(getLinkCheckExitCode(report));
})();
