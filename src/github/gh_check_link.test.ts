// Skeleton: the titles of main's tests, to port with the new design (STEP 2, GITHUB group).
import { describe, it } from "vitest";

describe("checkLinkWithGithubApi() with percent-encoded paths", () => {
  it.todo("passes a decoded release tag to Octokit (which encodes it once)");
  it.todo("accepts a release tag with an unencoded slash");
  it.todo("reports a missing (decoded) tag as broken link");
  it.todo("passes a decoded blob path and ref");
  it.todo("passes a decoded tree path");
  it.todo("passes a decoded commit ref");
  it.todo("does not throw on malformed percent-encoding");
});
describe("checkLinkWithGithubApi() with user and organization URLs", () => {
  it.todo("checks %s as an account, not as a repository");
  it.todo("still checks repository URLs as repositories");
  it.todo("accepts github.com itself");
});
describe("checkLinkWithGithubApi() with unknown sections", () => {
  it.todo("reports /owner/repo/%s/x as an unknown link type (no inherited object property)");
});
describe("checkLinkWithGithubApi() with unknown account URLs", () => {
  it.todo(
    "accepts an unknown account URL whose page exists (a GitHub page missing from the reserved routes)",
  );
  it.todo("reports the API 404 as broken link when the page of an unknown account answers %i");
  it.todo("does not fetch the page of an existing account");
});
describe("GitHub API errors", () => {
  it.todo("reports %i as unexpected error (not broken) for every link type");
  it.todo("reports a missing repository as broken link");
  it.todo("reports a missing branch or commit as broken link");
  it.todo("reports a deleted issue (410 Gone) as broken link");
});
describe("checkLinkWithGithubApi() with URL variants", () => {
  it.todo("https://github.com/o/r/issues");
  it.todo("ignores the query string of a tree link");
});
describe("checkLinkWithGithubApi() with tree links", () => {
  it.todo("resolves branch names with slashes, with or without a path");
});
describe("checkLinkWithGithubApi() with code line links", () => {
  it.todo("routes a code line link to the blob check (the file is read with the API)");
  it.todo("reports 'unexpected error' without a GH_TOKEN (checkLinks re-checks it in the browser)");
});
