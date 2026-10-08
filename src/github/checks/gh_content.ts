/**
 * Checks of the `blob/<ref>/<path>` (file, and its hash) and `tree/<ref>/<path>` (branch, commit, directory) parts
 * of a repository. Both share the ref resolution: branch and tag names can contain slashes, the URL doesn't say where
 * the ref ends.
 */
import { Effect, Either } from "effect";
import { GitHubApiError, type GitHubTimeout } from "../../errors";
import { decodeHash } from "../../hash";
import { checkLineAnchor, countLines } from "../../line_anchor";
import { hasMatchingAnchor } from "../../markdown";
import type { LinkCheckResult } from "../../types";
import { getApiErrorResult } from "../gh_api";
import { isGithubCodeLineLink } from "../gh_url";
import { type ContentInfo, GitHub, type GitHubError } from "../github_client";

type Repo = { readonly owner: string; readonly repo: string };

const isNotFound = (error: GitHubError): error is GitHubApiError =>
  error instanceof GitHubApiError && error.isNotFound;

/**
 * Names of the branches and tags that start with the first segment of a `<ref>/<path>` URL part and could be the ref
 * (`feature` or `feature/...`, not `feature-2`). A missing repository has no refs.
 */
const getRefCandidates = (github: GitHub["Type"], { owner, repo }: Repo, first: string) =>
  Effect.forEach(
    ["heads", "tags"] as const,
    (kind) =>
      github
        .listRefNames(owner, repo, kind, first)
        .pipe(Effect.catchIf(isNotFound, () => Effect.succeed([]))),
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map((listings) =>
      [...new Set(listings.flat())].filter(
        (name) => name === first || name.startsWith(`${first}/`),
      ),
    ),
  );

type RefPathContent = {
  readonly ref: string;
  readonly path: string;
  /** `undefined` if the URL is only a ref (proven by the ref listing) */
  readonly content: ContentInfo | undefined;
};

/**
 * Contents of the `<ref>/<path>` part of a blob or tree URL (`blob/<ref>/<path>`). Branch and tag names can contain
 * slashes (`blob/feature/x/src/a.ts`), the URL doesn't say where the ref ends:
 * - The first segment is tried as the ref (most links: `main`, a tag without slashes, a commit SHA).
 * - If that is not found, the branches and tags starting with the first segment are listed (see `getRefCandidates`),
 *   the longest one that is a prefix of the segments is the ref (any number of segments).
 * Only "not found" can mean the ref is longer, any other error is the answer.
 * @param segments decoded path segments after `blob` or `tree`
 * @param requirePath `true` for blobs (a file), `false` for trees (`tree/feature/x` is the root of `feature/x`)
 */
const findRefPath = Effect.fn("github.findRefPath")(function* (
  repo: Repo,
  segments: string[],
  { requirePath }: { requirePath: boolean },
) {
  const github = yield* GitHub;
  const [first = "", ...rest] = segments;
  const path = rest.join("/");

  const firstTry = yield* github.getContent(repo.owner, repo.repo, first, path).pipe(
    Effect.map((content): RefPathContent => ({ ref: first, path, content })),
    Effect.either,
  );
  if (Either.isRight(firstTry)) {
    return firstTry.right;
  }
  // Any other error (or a timeout) is the answer, a longer ref only helps after "not found"
  if (!isNotFound(firstTry.left) || segments.length < 2) {
    return yield* firstTry.left;
  }

  const candidates = new Set(yield* getRefCandidates(github, repo, first));
  // The URL prefixes that are listed refs, longest first: a branch `a/b` and a tag `a/b/c` can both exist
  const maxRefSegments = segments.length - (requirePath ? 1 : 0);
  for (let count = maxRefSegments; count >= 2; count--) {
    const ref = segments.slice(0, count).join("/");
    if (!candidates.has(ref)) {
      continue;
    }
    const refPath = segments.slice(count).join("/");
    if (!refPath) {
      // The listing proves the ref exists
      return { ref, path: refPath, content: undefined } satisfies RefPathContent;
    }
    const content = yield* github
      .getContent(repo.owner, repo.repo, ref, refPath)
      .pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
    if (content) {
      return { ref, path: refPath, content } satisfies RefPathContent;
    }
  }
  return yield* firstTry.left;
});

/** GitHub renders these files, their anchors are headings (see `getMarkdownAnchors`) */
const isRenderedMarkdown = (path: string, url: URL) =>
  /\.(md|markdown|mdown|mkdn|mkd|mdwn)$/i.test(path) && url.searchParams.get("plain") !== "1";

/** `GitHubApiError` as a link result, `GitHubTimeout` still fails the check */
const toResult =
  (notFoundDetail: string) =>
  <A, R>(effect: Effect.Effect<A, GitHubError, R>) =>
    Effect.catchTag(effect, "GitHubApiError", (error) =>
      Effect.succeed(getApiErrorResult(error, notFoundDetail)),
    );

/**
 * Check if a GitHub blob exists, and its hash: a heading of a markdown file, or a code line (`#L12`, `#L12-L15`,
 * `#L12C3-L15C1`, the file must have enough lines, see `checkLineAnchor`). Code lines are checked with the API, not in
 * the browser: github.com refuses blob pages to headless browsers on CI runners (503).
 * @param fullUrl - The full URL of the blob
 * @param owner - The owner of the repository
 * @param repo - The repository name
 * @param pathParts - The path parts of the URL
 */
export const checkGitHubBlobLink = Effect.fn("github.checkBlobLink")(function* (
  fullUrl: URL,
  owner: string,
  repo: string,
  pathParts: string[],
) {
  const github = yield* GitHub;
  // Remove the # character, decode percent-encoding and make it lowercase
  const hash = decodeHash(fullUrl.hash).toLowerCase();

  const checkHash = ({
    path,
    content,
  }: RefPathContent): Effect.Effect<LinkCheckResult, GitHubTimeout> => {
    // If there's no hash, we're done - the file exists
    if (!hash) {
      return Effect.succeed({ ok: true, status: 200 });
    }
    // For hash checking, we need the file content
    if (content?.content === undefined) {
      return Effect.succeed({
        ok: false,
        error: "hash not found",
        status: 200,
        errorDetail: "File has no content",
      });
    }
    return github.getFileText(owner, repo, content).pipe(
      Effect.map((fileText): LinkCheckResult => {
        const hasHeading = () => hasMatchingAnchor(fileText.getAnchors(), hash);
        // `#L12`, `#L12-L15`, `#L12C3-L15C1` (case-sensitive, `#l12` is not a line anchor), see `parseLineAnchor`
        const lineResult = isGithubCodeLineLink(fullUrl.href)
          ? checkLineAnchor(
              decodeHash(fullUrl.hash),
              fileText.binary ? 0 : countLines(fileText.text),
              fileText.binary ? `${path} (binary file)` : path,
            )
          : undefined;
        if (lineResult) {
          // Rendered markdown (without `?plain=1`): a heading like `## L12` matches too
          return !lineResult.ok && isRenderedMarkdown(path, fullUrl) && hasHeading()
            ? { ok: true, status: 200 }
            : lineResult;
        }
        return hasHeading()
          ? { ok: true, status: 200 }
          : {
              ok: false,
              error: "hash not found",
              status: 200,
              errorDetail: `No heading found matching hash: ${hash}`,
            };
      }),
      toResult("File content not found in repository"),
    );
  };

  return yield* findRefPath({ owner, repo }, pathParts.slice(1), { requirePath: true }).pipe(
    Effect.flatMap(checkHash),
    toResult("File not found in repository"),
  );
});

/**
 * Check if a GitHub branch/tag/commit (`tree/<ref>`) or a path in it (`tree/<ref>/<path>`) exists. The contents API
 * accepts a branch, tag or commit SHA as ref and an empty path (repository root).
 * @param owner - The owner of the repository
 * @param repo - The repository name
 * @param pathParts - The path parts of the URL
 */
export const checkGitHubTreeLink = Effect.fn("github.checkTreeLink")(function* (
  owner: string,
  repo: string,
  pathParts: string[],
) {
  // The ref can contain slashes: `tree/feature/x/src` (see `findRefPath`)
  const [, ref = "", ...restOfPath] = pathParts;
  const path = restOfPath.join("/");
  return yield* findRefPath({ owner, repo }, pathParts.slice(1), { requirePath: false }).pipe(
    Effect.as<LinkCheckResult>({ ok: true, status: 200 }),
    toResult(
      path
        ? `Path ${path} not found in branch, tag or commit ${ref}`
        : `No branch, tag or commit ${ref} found in repository ${owner}/${repo}`,
    ),
  );
});
