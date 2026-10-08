// Skeleton: the titles of main's tests, to port with the new design (STEP 2, GITHUB group).
import { describe, it } from "vitest";

describe("checkIfOwnerExists", () => {
  it.todo("reports a user or organization that does not exist as broken link");
});
describe("checkGitHubCommitLink", () => {
  it.todo("reports a commit SHA that does not exist as broken link");
  it.todo("reports a commit of a repository that does not exist as broken link");
});
describe("checkGitHubDiscussionLink", () => {
  it.todo("reports a discussion of a repository that does not exist as broken link");
});
describe("checkGitHubReleaseLink", () => {
  it.todo("accepts the latest release of a repository with releases");
  it.todo("reports the latest release of a repository that does not exist as broken link");
});
