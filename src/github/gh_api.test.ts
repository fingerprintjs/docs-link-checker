// Skeleton: the titles of main's tests, to port with the new design (STEP 2, GITHUB group).
import { describe, it } from "vitest";

describe("GitHub API cache (through checkLinkWithGithubApi)", () => {
  it.todo("dedupes concurrent checks of the same file within a run");
  it.todo("caches different refs, paths and repositories separately");
  it.todo("caches repositories (case-insensitive)");
  it.todo("does not share the cache between runs");
  it.todo("caches %i (the repository is definitely missing)");
  it.todo("does not cache %i");
  it.todo("checks many hashes of the same file with one API request");
  it.todo("counts cache hits in the run metrics (requests are counted by the Octokit client)");
});
