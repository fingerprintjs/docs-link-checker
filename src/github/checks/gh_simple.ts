/**
 * Existence checks of GitHub links through the API: repository, owner, commit, pull request, issue, discussion, release.
 * STUB: implemented by the GITHUB group. Only `GitHubTimeout` can fail, `GitHubApiError` becomes a result.
 */
import { Effect } from "effect";
import type { GitHubTimeout } from "../../errors";
import type { LinkCheckResult } from "../../types";
import type { GitHub } from "../github_client";

type Check<Args extends unknown[]> = (
  ...args: Args
) => Effect.Effect<LinkCheckResult, GitHubTimeout, GitHub>;

export const checkIfRepositoryExists: Check<[owner: string, repo: string]> = () =>
  Effect.die("not implemented");
export const checkIfOwnerExists: Check<[owner: string]> = () => Effect.die("not implemented");
/** 422 is "Commit not found" */
export const checkGitHubCommitLink: Check<
  [owner: string, repo: string, pathParts: string[]]
> = () => Effect.die("not implemented");
export const checkGitHubPullRequestLink: Check<
  [owner: string, repo: string, pathParts: string[]]
> = () => Effect.die("not implemented");
export const checkGitHubIssueLink: Check<[owner: string, repo: string, pathParts: string[]]> = () =>
  Effect.die("not implemented");
export const checkGitHubDiscussionLink: Check<
  [owner: string, repo: string, discussionNumber: number]
> = () => Effect.die("not implemented");
export const checkGitHubReleaseLink: Check<
  [owner: string, repo: string, pathParts: string[]]
> = () => Effect.die("not implemented");
