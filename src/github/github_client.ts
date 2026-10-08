/**
 * GitHub API as one service: typed methods (Octokit inside), caches per run, request metrics, timeouts.
 * `GitHubApi` exposes only the fields the checks read, so test fakes stay small.
 * STUB: interface is final, `GitHub.layer` is implemented by the GITHUB group.
 */
import { Context, Effect, Layer } from "effect";
import type { GitHubApiError, GitHubTimeout } from "../errors";
import type { Fetch } from "../http";
import type { Metrics } from "../metrics";

export type RepoInfo = { readonly default_branch: string };
export type FileInfo = {
  readonly content: string;
  readonly encoding?: string;
  readonly sha: string;
  readonly size?: number;
};
/** A file, or a directory listing / symlink / submodule */
export type ContentInfo = FileInfo | { readonly content?: undefined };
export type ReleaseInfo = { readonly assets: ReadonlyArray<{ readonly name: string }> };
export type OrgRepo = {
  readonly full_name: string;
  readonly name: string;
  readonly archived?: boolean;
  readonly owner: { readonly login: string };
};
export type TreeEntry = { readonly type?: string; readonly path?: string };
/** Anchors are parsed once, lazily */
export type FileText = {
  readonly text: string;
  readonly binary: boolean;
  readonly getAnchors: () => Set<string>;
};
export type GitHubError = GitHubApiError | GitHubTimeout;

export type GitHubApi = {
  /** Cached (lowercase key) */
  readonly getRepo: (owner: string, repo: string) => Effect.Effect<RepoInfo, GitHubError>;
  /** User or organization, cached */
  readonly getUser: (username: string) => Effect.Effect<void, GitHubError>;
  readonly getCommit: (
    owner: string,
    repo: string,
    ref: string,
  ) => Effect.Effect<void, GitHubError>;
  readonly getPullRequest: (
    owner: string,
    repo: string,
    number: number,
  ) => Effect.Effect<void, GitHubError>;
  readonly getIssue: (
    owner: string,
    repo: string,
    number: number,
  ) => Effect.Effect<void, GitHubError>;
  /** GraphQL NOT_FOUND is a `GitHubApiError` with status 404 */
  readonly getDiscussion: (
    owner: string,
    repo: string,
    number: number,
  ) => Effect.Effect<void, GitHubError>;
  readonly getReleaseByTag: (
    owner: string,
    repo: string,
    tag: string,
  ) => Effect.Effect<ReleaseInfo, GitHubError>;
  readonly getRelease: (
    owner: string,
    repo: string,
    releaseId: number,
  ) => Effect.Effect<void, GitHubError>;
  readonly hasReleases: (owner: string, repo: string) => Effect.Effect<boolean, GitHubError>;
  /** Cached */
  readonly getContent: (
    owner: string,
    repo: string,
    ref: string,
    path: string,
  ) => Effect.Effect<ContentInfo, GitHubError>;
  /** Matching refs, all pages, names without `refs/<kind>/`, cached */
  readonly listRefNames: (
    owner: string,
    repo: string,
    kind: "heads" | "tags",
    prefix: string,
  ) => Effect.Effect<ReadonlyArray<string>, GitHubError>;
  /** Base64 decode, blobs API for files over 1 MB, cached by sha */
  readonly getFileText: (
    owner: string,
    repo: string,
    file: FileInfo,
  ) => Effect.Effect<FileText, GitHubError>;
  /** Public repos, all pages */
  readonly listOrgRepos: (org: string) => Effect.Effect<ReadonlyArray<OrgRepo>, GitHubError>;
  /** Recursive tree */
  readonly getTreeEntries: (
    owner: string,
    repo: string,
    ref: string,
  ) => Effect.Effect<ReadonlyArray<TreeEntry>, GitHubError>;
  readonly getRateLimit: Effect.Effect<
    { readonly remaining: number; readonly reset: number },
    GitHubError
  >;
};

const notImplemented = Effect.die("not implemented");

export class GitHub extends Context.Tag("GitHub")<GitHub, GitHubApi>() {
  // STUB
  static readonly layer: Layer.Layer<GitHub, never, Fetch | Metrics> = Layer.succeed(GitHub, {
    getRepo: () => notImplemented,
    getUser: () => notImplemented,
    getCommit: () => notImplemented,
    getPullRequest: () => notImplemented,
    getIssue: () => notImplemented,
    getDiscussion: () => notImplemented,
    getReleaseByTag: () => notImplemented,
    getRelease: () => notImplemented,
    hasReleases: () => notImplemented,
    getContent: () => notImplemented,
    listRefNames: () => notImplemented,
    getFileText: () => notImplemented,
    listOrgRepos: () => notImplemented,
    getTreeEntries: () => notImplemented,
    getRateLimit: notImplemented,
  });
}
