import { checkLinkWithFetch } from "../check/fetch_check";
import { decodeHash } from "../check/hash";
import { checkLineAnchor, countLines, parseLineAnchor } from "../check/line_anchor";
import { getMarkdownAnchors, hasMatchingAnchor } from "../sources/markdown";
import type { LinkCheckResult } from "../types";
import { tryCatch } from "../utils/try_catch";
import { getApiErrorStatus, getRepo, githubRequest, isNotFoundApiError } from "./client";
import { getGithubPathSegments } from "./url";

/**
 * Checks a GitHub link with the GitHub API (`fetch` runs into github.com rate limits fast).
 * - The URL is parsed once into a `GithubTarget` (a repository, an issue, a file...), each kind has its check.
 * - A definitive "not found" is a broken link. Any other API error (rate limit, bad token, network error) is an
 *   "unexpected error", re-checked in the browser (see `shouldRecheckWithPlaywright`).
 * - All requests go through `githubRequest`: cached for the run, aborted when no check waits for them anymore.
 */

type Repo = { owner: string; repo: string };

/** What a GitHub URL points to */
type GithubTarget =
  /** The answer is known without a request */
  | { kind: "result"; result: LinkCheckResult }
  /** A user or an organization (`https://github.com/owner`) */
  | { kind: "owner"; owner: string }
  | ({ kind: "repo" } & Repo)
  | ({ kind: "issue"; issueNumber: number } & Repo)
  | ({ kind: "pull"; pullNumber: number } & Repo)
  | ({ kind: "commit"; ref: string } & Repo)
  | ({ kind: "discussion"; discussionNumber: number } & Repo)
  | ({ kind: "release"; releaseId: number } & Repo)
  | ({ kind: "release-tag"; tag: string } & Repo)
  | ({ kind: "release-asset"; tag: string; asset: string } & Repo)
  /** `/releases/latest`: the repository has at least one release */
  | ({ kind: "latest-release" } & Repo)
  /**
   * A file and its hash (decoded, without `#`): a heading or a code line (`#L12`)
   * @param segments decoded path segments after `blob`: the ref, then the path (see `getRefPathContent`)
   * @param plain `?plain=1`: markdown shown as source, its headings are not anchors
   */
  | ({ kind: "blob"; segments: string[]; hash: string; plain: boolean } & Repo)
  /** A branch, tag or commit, or a directory in it (decoded path segments after `tree`) */
  | ({ kind: "tree"; segments: string[] } & Repo);

const OK: LinkCheckResult = { ok: true, status: 200 };

const brokenLink = (errorDetail: string, status?: number): LinkCheckResult => ({
  ok: false,
  error: "broken link",
  errorDetail,
  ...(status !== undefined ? { status } : {}),
});

const hashNotFound = (errorDetail: string): LinkCheckResult => ({
  ok: false,
  error: "hash not found",
  status: 200,
  errorDetail,
});

/** A failed request as a result: broken link if `isMissing`, an "unexpected error" otherwise */
const errorResult = (
  error: unknown,
  notFoundDetail: string,
  isMissing = isNotFoundApiError,
): LinkCheckResult => {
  const status = getApiErrorStatus(error);
  if (isMissing(error)) {
    // GraphQL answers "not found" in a 200 response, without a status
    return brokenLink(notFoundDetail, status ?? 404);
  }
  return {
    ok: false,
    error: "unexpected error",
    ...(status !== undefined ? { status } : {}),
    errorDetail: String(error),
  };
};

/** OK if `request` resolves (the resource exists) */
const checkExists = async (
  request: Promise<unknown>,
  notFoundDetail: string,
  isMissing = isNotFoundApiError,
): Promise<LinkCheckResult> => {
  const { error } = await tryCatch(request);
  return error ? errorResult(error, notFoundDetail, isMissing) : OK;
};

/** Sections whose index page (`/owner/repo/issues`) exists for every repository */
const SECTIONS_WITH_INDEX_PAGE = new Set(["issues", "discussions", "releases", "pulls"]);

const parseRelease = (target: Repo, [kind = "", ...rest]: string[]): GithubTarget => {
  if (kind === "download") {
    const [tag = "", asset = ""] = rest;
    return { kind: "release-asset", ...target, tag, asset };
  }
  if (kind === "latest") {
    return { kind: "latest-release", ...target };
  }
  if (kind === "tag") {
    // Tags can contain slashes (`@fingerprint/vue@2.0.0`), written encoded (`%2F`) or not
    return { kind: "release-tag", ...target, tag: rest.join("/") };
  }
  const releaseId = parseInt(kind, 10);
  if (!Number.isNaN(releaseId)) {
    return { kind: "release", ...target, releaseId };
  }
  return { kind: "result", result: brokenLink("Invalid release URL format", 404) };
};

const parseGithubUrl = (url: URL): GithubTarget => {
  // Segments are decoded (`%40` -> `@`), Octokit encodes them again in the API request
  const [owner, repo, section, ...rest] = getGithubPathSegments(url);
  // `https://github.com/` itself
  if (!owner) {
    return { kind: "result", result: OK };
  }
  // With or without a trailing slash
  if (!repo) {
    return { kind: "owner", owner };
  }
  const target = { owner, repo };
  if (section === undefined || (rest.length === 0 && SECTIONS_WITH_INDEX_PAGE.has(section))) {
    return { kind: "repo", ...target };
  }
  const unknown: GithubTarget = {
    kind: "result",
    result: {
      ok: false,
      error: "unexpected error",
      status: 400,
      errorDetail: `Unknown link type: ${[section, ...rest].join("/")}`,
    },
  };
  const [first = ""] = rest;
  switch (section) {
    case "issues": {
      if (first === "new") {
        return { kind: "result", result: OK };
      }
      const issueNumber = parseInt(first, 10);
      return Number.isNaN(issueNumber)
        ? { kind: "result", result: brokenLink(`Invalid issue number format: ${first}`) }
        : { kind: "issue", ...target, issueNumber };
    }
    case "pull": {
      const pullNumber = parseInt(first, 10);
      return Number.isNaN(pullNumber)
        ? { kind: "result", result: brokenLink("Invalid pull request number", 404) }
        : { kind: "pull", ...target, pullNumber };
    }
    case "discussions": {
      const discussionNumber = parseInt(first, 10);
      // Other discussion pages (`/discussions/categories/x`) are checked in the browser
      return Number.isNaN(discussionNumber)
        ? unknown
        : { kind: "discussion", ...target, discussionNumber };
    }
    case "commit":
      return { kind: "commit", ...target, ref: first };
    case "releases":
      return parseRelease(target, rest);
    case "blob":
      return {
        kind: "blob",
        ...target,
        segments: rest,
        hash: decodeHash(url.hash),
        plain: url.searchParams.get("plain") === "1",
      };
    case "tree":
      return { kind: "tree", ...target, segments: rest };
    default:
      return unknown;
  }
};

/** GitHub answers an unknown SHA with 422 "No commit found for SHA", only on this endpoint */
const isMissingCommit = (error: unknown) =>
  isNotFoundApiError(error) || getApiErrorStatus(error) === 422;

/** GraphQL answers a missing discussion or repository with a NOT_FOUND error in a 200 response */
const isMissingDiscussion = (error: unknown): boolean => {
  const { errors, message } = (error ?? {}) as { errors?: { type?: string }[]; message?: string };
  return (
    isNotFoundApiError(error) ||
    errors?.some((e) => e.type === "NOT_FOUND") === true ||
    /Could not resolve to a (Discussion|Repository)/.test(message ?? "")
  );
};

const DISCUSSION_QUERY = `query ($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    discussion(number: $number) {
      id
    }
  }
}`;

const getReleaseByTag = ({ owner, repo, tag }: Repo & { tag: string }, signal: AbortSignal) =>
  githubRequest(
    "release-tag",
    { owner, repo, tag },
    (api, params) => api.repos.getReleaseByTag(params),
    { signal },
  );

/** Text of a file, `binary` if it contains a NUL byte (GitHub shows no lines for binary files) */
type FileText = { text: string; binary: boolean; anchors: () => Set<string> };

const toFileText = (base64: string): FileText => {
  const buffer = Buffer.from(base64, "base64");
  const text = buffer.toString("utf8");
  // Computed once per file, for all its hashes (the file is cached for the run)
  let anchors: Set<string> | undefined;
  return {
    text,
    binary: buffer.includes(0),
    anchors: () => (anchors ??= getMarkdownAnchors(text)),
  };
};

/**
 * An entry of the contents API. `text` is `undefined` for files over 1 MB: the API sends no content
 * (`encoding: "none"`), see `getLargeFileText`.
 */
type Content = { kind: "file"; sha: string; text?: FileText } | { kind: "other" };

const getContent = (params: Repo & { ref: string; path: string }, signal: AbortSignal) =>
  githubRequest(
    "content",
    params,
    async (api, request): Promise<Content> => {
      const { data } = await api.repos.getContent(request);
      // A directory, symlink or submodule
      if (Array.isArray(data) || data.content === undefined) {
        return { kind: "other" };
      }
      const isLarge = data.encoding === "none" || (data.content === "" && (data.size ?? 0) > 0);
      return { kind: "file", sha: data.sha, text: isLarge ? undefined : toFileText(data.content) };
    },
    { signal },
  );

/** `GET /repos/{owner}/{repo}/git/blobs/{sha}` reads files up to 100 MB */
const getLargeFileText = (owner: string, repo: string, sha: string, signal: AbortSignal) =>
  githubRequest(
    "blob",
    { owner, repo, file_sha: sha },
    async (api, params) => toFileText((await api.git.getBlob(params)).data.content),
    { signal },
  );

/**
 * Names of the branches and tags that start with the first segment of a `<ref>/<path>` URL part (a prefix match:
 * `feature` lists `feature-2` too). A missing repository has no refs.
 */
const getRefCandidates = async (
  owner: string,
  repo: string,
  first: string,
  signal: AbortSignal,
): Promise<Set<string>> => {
  const listings = await Promise.all(
    (["heads", "tags"] as const).map(async (kind) => {
      // `GET /repos/{owner}/{repo}/git/matching-refs/{ref}`: refs whose name starts with the prefix
      const { data, error } = await tryCatch(
        githubRequest(
          "matching-refs",
          { owner, repo, ref: `${kind}/${first}` },
          (api, params) => api.paginate(api.git.listMatchingRefs, params),
          { signal },
        ),
      );
      if (error) {
        if (isNotFoundApiError(error)) {
          return [];
        }
        throw error;
      }
      const prefix = `refs/${kind}/`;
      return data.flatMap(({ ref }) => (ref.startsWith(prefix) ? [ref.slice(prefix.length)] : []));
    }),
  );
  return new Set(listings.flat());
};

type RefPathContent =
  | {
      found: true;
      path: string;
      /** `undefined` if the URL is only a ref (proven by the ref listing) */
      content: Content | undefined;
    }
  | { found: false; error: unknown };

/**
 * Contents API entry of the `<ref>/<path>` part of a blob or tree URL. Branch and tag names can contain slashes
 * (`blob/feature/x/src/a.ts`), the URL doesn't say where the ref ends:
 * - The first segment is tried as the ref (most links: `main`, a tag without slashes, a commit SHA).
 * - If that is not found, the branches and tags starting with the first segment are listed (see `getRefCandidates`),
 *   the longest one that is a prefix of the segments is the ref (any number of segments).
 * Only "not found" can mean the ref is longer, any other error is the answer.
 * @param requirePath `true` for blobs (a file), `false` for trees (`tree/feature/x` is the root of `feature/x`)
 */
const getRefPathContent = async (
  { owner, repo, segments }: Repo & { segments: string[] },
  requirePath: boolean,
  signal: AbortSignal,
): Promise<RefPathContent> => {
  const [first = "", ...rest] = segments;
  const path = rest.join("/");
  const firstTry = await tryCatch(getContent({ owner, repo, ref: first, path }, signal));
  if (firstTry.data) {
    return { found: true, path, content: firstTry.data };
  }
  if (!isNotFoundApiError(firstTry.error) || segments.length < 2) {
    return { found: false, error: firstTry.error };
  }

  const { data: candidateRefs, error: listError } = await tryCatch(
    getRefCandidates(owner, repo, first, signal),
  );
  if (listError) {
    return { found: false, error: listError };
  }
  const maxRefSegments = segments.length - (requirePath ? 1 : 0);
  // The URL prefixes that are listed refs, longest first: a branch `a/b` and a tag `a/b/c` can both exist
  const refSegmentCounts: number[] = [];
  for (let count = maxRefSegments; count >= 2; count--) {
    if (candidateRefs.has(segments.slice(0, count).join("/"))) {
      refSegmentCounts.push(count);
    }
  }

  for (const count of refSegmentCounts) {
    const ref = segments.slice(0, count).join("/");
    const refPath = segments.slice(count).join("/");
    if (!refPath) {
      // The listing proves the ref exists
      return { found: true, path: refPath, content: undefined };
    }
    const { data, error } = await tryCatch(getContent({ owner, repo, ref, path: refPath }, signal));
    if (data) {
      return { found: true, path: refPath, content: data };
    }
    if (!isNotFoundApiError(error)) {
      return { found: false, error };
    }
  }
  return { found: false, error: firstTry.error };
};

/** GitHub renders these files, their anchors are headings (see `getMarkdownAnchors`) */
const isRenderedMarkdown = (path: string, plain: boolean) =>
  /\.(md|markdown|mdown|mkdn|mkd|mdwn)$/i.test(path) && !plain;

/**
 * A file and its hash: a heading of a markdown file, or a code line (`#L12`, `#L12-L15`, `#L12C3-L15C1`, the file
 * must have enough lines, see `checkLineAnchor`). Code lines are checked with the API, not in the browser: github.com
 * refuses blob pages to headless browsers on CI runners (503).
 */
const checkBlob = async (
  target: Extract<GithubTarget, { kind: "blob" }>,
  signal: AbortSignal,
): Promise<LinkCheckResult> => {
  const { owner, repo, hash, plain } = target;
  const found = await getRefPathContent(target, true, signal);
  if (!found.found) {
    return errorResult(found.error, "File not found in repository");
  }
  if (!hash) {
    return OK;
  }
  const { content, path } = found;
  if (content?.kind !== "file") {
    return hashNotFound("File has no content");
  }
  const { data: fileText, error } = await tryCatch(
    content.text
      ? Promise.resolve(content.text)
      : getLargeFileText(owner, repo, content.sha, signal),
  );
  if (error) {
    return errorResult(error, "File content not found in repository");
  }

  // Headings match in lowercase, with or without `user-content-`
  const hasHeading = () => hasMatchingAnchor(fileText.anchors(), hash.toLowerCase());
  // `#L12`, `#L12-L15`, `#L12C3-L15C1` (case-sensitive, `#l12` is not a line anchor)
  if (parseLineAnchor(hash)) {
    const lineResult = fileText.binary
      ? checkLineAnchor(hash, 0, `${path} (binary file)`)
      : checkLineAnchor(hash, countLines(fileText.text), path);
    // Rendered markdown (without `?plain=1`): a heading like `## L12` matches too
    if (lineResult && !lineResult.ok && isRenderedMarkdown(path, plain) && hasHeading()) {
      return OK;
    }
    return lineResult ?? OK;
  }
  return hasHeading() ? OK : hashNotFound(`No heading found matching hash: ${hash.toLowerCase()}`);
};

/**
 * A branch, tag or commit (`tree/<ref>`) or a path in it (`tree/<ref>/<path>`). The contents API accepts a branch,
 * tag or commit SHA as ref and an empty path (repository root).
 */
const checkTree = async (
  target: Extract<GithubTarget, { kind: "tree" }>,
  signal: AbortSignal,
): Promise<LinkCheckResult> => {
  const found = await getRefPathContent(target, false, signal);
  if (found.found) {
    return OK;
  }
  const [ref = "", ...restOfPath] = target.segments;
  const path = restOfPath.join("/");
  return errorResult(
    found.error,
    path
      ? `Path ${path} not found in branch, tag or commit ${ref}`
      : `No branch, tag or commit ${ref} found in repository ${target.owner}/${target.repo}`,
  );
};

/** `GET /users/{owner}` works for both a user and an organization */
const checkOwner = async (
  url: string,
  owner: string,
  signal: AbortSignal,
): Promise<LinkCheckResult> => {
  const result = await checkExists(
    githubRequest("user", { username: owner }, (api, params) => api.users.getByUsername(params), {
      signal,
    }),
    `User or organization ${owner} not found`,
  );
  // Not an account: maybe one of GitHub's own pages missing from the reserved routes, check the page itself
  if (!result.ok && result.error === "broken link") {
    const page = await checkLinkWithFetch(url);
    if (page.ok) {
      return page;
    }
  }
  return result;
};

/** Everything in a repository */
type RepoTarget = Exclude<GithubTarget, { kind: "result" | "owner" }>;

const checkRepoTarget = async (
  target: RepoTarget,
  signal: AbortSignal,
): Promise<LinkCheckResult> => {
  const { owner, repo } = target;
  switch (target.kind) {
    case "blob":
      return checkBlob(target, signal);
    case "tree":
      return checkTree(target, signal);
    case "repo":
      return checkExists(getRepo(owner, repo, signal), `Repository ${owner}/${repo} not found`);
    case "issue":
      // 410: the issue was deleted
      return checkExists(
        githubRequest(
          "issue",
          { owner, repo, issue_number: target.issueNumber },
          (api, params) => api.issues.get(params),
          { signal },
        ),
        `Issue #${target.issueNumber} not found in repository ${owner}/${repo}`,
      );
    case "pull":
      return checkExists(
        githubRequest(
          "pull",
          { owner, repo, pull_number: target.pullNumber },
          (api, params) => api.pulls.get(params),
          { signal },
        ),
        `Pull request #${target.pullNumber} not found in repository ${owner}/${repo}`,
      );
    case "commit":
      return checkExists(
        githubRequest(
          "commit",
          { owner, repo, ref: target.ref },
          (api, params) => api.repos.getCommit(params),
          { signal, isMissing: isMissingCommit },
        ),
        "Commit not found",
        isMissingCommit,
      );
    case "discussion":
      return checkExists(
        githubRequest(
          "discussion",
          { owner, repo, number: target.discussionNumber },
          (api, params) => api.graphql(DISCUSSION_QUERY, params),
          { signal, isMissing: isMissingDiscussion },
        ),
        `Discussion #${target.discussionNumber} not found in repository ${owner}/${repo}`,
        isMissingDiscussion,
      );
    case "release":
      return checkExists(
        githubRequest(
          "release",
          { owner, repo, release_id: target.releaseId },
          (api, params) => api.repos.getRelease(params),
          { signal },
        ),
        `Release #${target.releaseId} not found in repository ${owner}/${repo}`,
      );
    case "release-tag":
      return checkExists(
        getReleaseByTag(target, signal),
        `Release tag ${target.tag} not found in repository ${owner}/${repo}`,
      );
    case "release-asset": {
      const { tag, asset } = target;
      const { data: release, error } = await tryCatch(getReleaseByTag(target, signal));
      if (error) {
        return errorResult(error, `Release tag ${tag} not found in repository ${owner}/${repo}`);
      }
      return release.data.assets.some(({ name }) => name === asset)
        ? OK
        : brokenLink(
            `Asset ${asset} not found in release ${tag} of repository ${owner}/${repo}`,
            404,
          );
    }
    case "latest-release": {
      const { data: releases, error } = await tryCatch(
        githubRequest(
          "latest-release",
          { owner, repo, per_page: 1 },
          (api, params) => api.repos.listReleases(params),
          { signal },
        ),
      );
      if (error) {
        return errorResult(error, `Repository ${owner}/${repo} not found`);
      }
      return releases.data.length === 0 ? brokenLink("No releases found in repository", 404) : OK;
    }
  }
};

/**
 * Checks a GitHub link with the GitHub API, for example
 * https://github.com/fingerprintjs/fingerprintjs-pro-angular/blob/main/README.md#documentation
 * Callers must route wiki links, GitHub's own pages and non-GitHub URLs elsewhere (see `getInitialCheckMethod`).
 * @param signal stops the check (it timed out)
 */
export const checkLinkWithGithubApi = (
  url: string,
  signal: AbortSignal,
): Promise<LinkCheckResult> => {
  const target = parseGithubUrl(new URL(url));
  if (target.kind === "result") {
    return Promise.resolve(target.result);
  }
  if (target.kind === "owner") {
    return checkOwner(url, target.owner, signal);
  }
  return checkRepoTarget(target, signal);
};
