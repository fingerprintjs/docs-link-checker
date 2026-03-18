type LinkCheckSummary = {
  totalLinksToFix: number;
};

type LinkCheckReport = {
  summary: LinkCheckSummary;
};

const FAIL_ON_LINK_ISSUES_ENV = "FAIL_ON_LINK_ISSUES";

export const shouldFailOnLinkIssues = (env: NodeJS.ProcessEnv = process.env) =>
  env[FAIL_ON_LINK_ISSUES_ENV] !== "false";

export const getLinkCheckExitCode = (
  report: LinkCheckReport,
  env: NodeJS.ProcessEnv = process.env
) => {
  if (report.summary.totalLinksToFix === 0) {
    return 0;
  }

  if (shouldFailOnLinkIssues(env)) {
    return 1;
  }

  console.log(
    `Link issues found, but continuing because ${FAIL_ON_LINK_ISSUES_ENV}=false for this run.`
  );
  return 0;
};
