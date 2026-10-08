// Skeleton: the titles of main's tests, to port with the new design (STEP 2, GITHUB group).
import { describe, it } from "vitest";

describe("checkGitHubCommitLink()", () => {
  it.todo("is OK for an existing commit");
  it.todo("reports a %s as broken link");
  it.todo("reports a rate limit (403) as unexpected error");
});
describe("checkGitHubDiscussionLink()", () => {
  it.todo("is OK for an existing discussion");
  it.todo("is a broken link for a %s");
  it.todo("is an unexpected error for a %s");
});
describe("checkGitHubIssueLink() and checkGitHubPullRequestLink()", () => {
  it.todo("accepts the new issue page without a request");
  it.todo("reports an issue number that is not a number as broken link, without a request");
  it.todo("reports a pull request number that is not a number as broken link, without a request");
});
describe("checkGitHubReleaseLink()", () => {
  it.todo("accepts an asset that is part of the release");
  it.todo("reports an asset that is not part of the release as broken link");
  it.todo("accepts /releases/latest when the repository has a release");
  it.todo("reports /releases/latest of a repository without releases as broken link");
  it.todo("checks a release by its numeric ID");
  it.todo("joins the segments of a tag with slashes");
  it.todo("reports an unknown release URL as broken link");
});
