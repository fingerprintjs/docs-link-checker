import { Effect, Either } from "effect";
import { decodeHash } from "../../hash";
import { checkLineAnchor, countLines } from "../../line_anchor";
import { getMarkdownAnchors, hasMatchingAnchor } from "../../markdown";
import type { LinkCheckResult } from "../../types";
import { cachedRequest, getApiErrorResult, isNotFoundApiError } from "../gh_api";
import { isGithubCodeLineLink } from "../gh_url";
import type { GitHubServices } from "../github_client";

/**
 * Checks of the `blob/<ref>/<path>` (file, and its hash) and `tree/<ref>/<path>` (branch, commit, directory) parts
 * of a repository. Both share the ref resolution: branch and tag names can contain slashes, the URL doesn't say where
 * the ref ends.
 */

const getContent = (owner: string, repo: string, ref: string, path: string) =>
  cachedRequest(["content", owner.toLowerCase(), repo.toLowerCase(), ref, path], (octokit) =>
    octokit.repos.getContent({ owner, repo, ref, path }),
  );

/**
 * Names of the branches and tags that start with the first segment of a `<ref>/<path>` URL part and could be the ref
 * (`feature` or `feature/...`, not `feature-2`), one cached listing of branches and one of tags per repository and
 * first segment. A missing repository has no refs.
 */
const getRefCandidates = (owner: string, repo: string, first: string) =>
  Effect.forEach(
    ["heads", "tags"] as const,
    (kind) =>
      // `GET /repos/{owner}/{repo}/git/matching-refs/{ref}` (all pages): refs whose name starts with the prefix
      cachedRequest(
        ["matching-refs", owner.toLowerCase(), repo.toLowerCase(), `${kind}/${first}`],
        (octokit) =>
          octokit.paginate(octokit.git.listMatchingRefs, { owner, repo, ref: `${kind}/${first}` }),
      ).pipe(
        Effect.map((data) => {
          const prefix = `refs/${kind}/`;
          return data.flatMap(({ ref }) =>
            ref.startsWith(prefix) ? [ref.slice(prefix.length)] : [],
          );
        }),
        Effect.catchIf(isNotFoundApiError, () => Effect.succeed([] as string[])),
      ),
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map((listings) =>
      [...new Set(listings.flat())].filter(
        (name) => name === first || name.startsWith(`${first}/`),
      ),
    ),
  );

/**
 * Contents API response of the `<ref>/<path>` part of a blob or tree URL (`blob/<ref>/<path>`). Branch and tag names
 * can contain slashes (`blob/feature/x/src/a.ts`), the URL doesn't say where the ref ends:
 * - The first segment is tried as the ref (most links: `main`, a tag without slashes, a commit SHA).
 * - If that is not found, the branches and tags starting with the first segment are listed (see `getRefCandidates`),
 *   the longest one that is a prefix of the segments is the ref (any number of segments).
 * Only "not found" can mean the ref is longer, any other error is the answer.
 * @param segments decoded path segments after `blob` or `tree`
 * @param requirePath `true` for blobs (a file), `false` for trees (`tree/feature/x` is the root of `feature/x`)
 */
const getRefPathContent = (
  owner: string,
  repo: string,
  segments: string[],
  { requirePath }: { requirePath: boolean },
) =>
  Effect.gen(function* () {
    const [first = "", ...rest] = segments;
    const path = rest.join("/");
    const firstTry = yield* Effect.either(getContent(owner, repo, first, path));
    if (Either.isRight(firstTry)) {
      return { found: true, ref: first, path, response: firstTry.right } as const;
    }
    const firstError = firstTry.left;
    if (!isNotFoundApiError(firstError) || segments.length < 2) {
      return { found: false, error: firstError } as const;
    }

    const candidates = yield* Effect.either(getRefCandidates(owner, repo, first));
    if (Either.isLeft(candidates)) {
      return { found: false, error: candidates.left } as const;
    }
    const maxRefSegments = segments.length - (requirePath ? 1 : 0);
    const candidateRefs = new Set(candidates.right);
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
        // The listing proves the ref exists, no contents response needed
        return { found: true, ref, path: refPath, response: undefined } as const;
      }
      const result = yield* Effect.either(getContent(owner, repo, ref, refPath));
      if (Either.isRight(result)) {
        return { found: true, ref, path: refPath, response: result.right } as const;
      }
      if (!isNotFoundApiError(result.left)) {
        return { found: false, error: result.left } as const;
      }
    }
    return { found: false, error: firstError } as const;
  });

// Decoded text per file response: the response is cached for the run, so each file is decoded once for all its hashes
const textByFile = new WeakMap<object, FileText>();
// Anchors per file text
const anchorsByText = new WeakMap<FileText, Set<string>>();

/** Text of a file, `binary` if it contains a NUL byte (GitHub shows no lines for binary files) */
type FileText = { text: string; binary: boolean };

/** A file from the contents API (not a directory, symlink or submodule) */
type FileData = { content: string; encoding?: string; sha: string; size?: number };

/**
 * Text of a file. Files over 1 MB have no content in the contents API (`encoding: "none"`), they are read with
 * `GET /repos/{owner}/{repo}/git/blobs/{sha}` (up to 100 MB). A blob never changes, cached per sha.
 */
const getFileText = (owner: string, repo: string, file: FileData) =>
  Effect.gen(function* () {
    const known = textByFile.get(file);
    if (known) {
      return known;
    }
    const isLarge = file.encoding === "none" || (file.content === "" && (file.size ?? 0) > 0);
    const base64 = isLarge
      ? (yield* cachedRequest(
          ["blob", owner.toLowerCase(), repo.toLowerCase(), file.sha],
          (octokit) => octokit.git.getBlob({ owner, repo, file_sha: file.sha }),
        )).data.content
      : file.content;
    const buffer = Buffer.from(base64, "base64");
    // Decoded text is shared by hashes of the file checked at the same time (see `getTextAnchors`)
    const text = textByFile.get(file) ?? {
      text: buffer.toString("utf8"),
      binary: buffer.includes(0),
    };
    textByFile.set(file, text);
    return text;
  });

const getTextAnchors = (fileText: FileText): Set<string> => {
  let anchors = anchorsByText.get(fileText);
  if (!anchors) {
    anchors = getMarkdownAnchors(fileText.text);
    anchorsByText.set(fileText, anchors);
  }
  return anchors;
};

/** GitHub renders these files, their anchors are headings (see `getMarkdownAnchors`) */
const isRenderedMarkdown = (path: string, url: URL) =>
  /\.(md|markdown|mdown|mkdn|mkd|mdwn)$/i.test(path) && url.searchParams.get("plain") !== "1";

/** `true` if the heading anchors of the file include the hash (lowercase, with or without `user-content-`) */
const hasHeadingAnchor = (fileText: FileText, hash: string) =>
  hasMatchingAnchor(getTextAnchors(fileText), hash);

/**
 * Check if a GitHub blob exists, and its hash: a heading of a markdown file, or a code line (`#L12`, `#L12-L15`,
 * `#L12C3-L15C1`, the file must have enough lines, see `checkLineAnchor`). Code lines are checked with the API, not in the browser:
 * github.com refuses blob pages to headless browsers on CI runners (503).
 * @param fullUrl - The full URL of the blob
 * @param owner - The owner of the repository
 * @param repo - The repository name
 * @param pathParts - The path parts of the URL
 * @returns - A LinkCheckResult object
 */
export const checkGitHubBlobLink = (
  fullUrl: URL,
  owner: string,
  repo: string,
  pathParts: string[],
): Effect.Effect<LinkCheckResult, never, GitHubServices> =>
  Effect.gen(function* () {
    // Remove the # character, decode percent-encoding and make it lowercase
    const hash = decodeHash(fullUrl.hash).toLowerCase();

    const content = yield* getRefPathContent(owner, repo, pathParts.slice(1), {
      requirePath: true,
    });
    if (!content.found) {
      return getApiErrorResult(content.error, "File not found in repository");
    }

    // If there's no hash, we're done - the file exists
    if (!hash) {
      return { ok: true, status: 200 };
    }

    // For hash checking, we need to get the file content
    const fileData = content.response?.data;
    if (!fileData || !("content" in fileData)) {
      return {
        ok: false,
        error: "hash not found",
        status: 200,
        errorDetail: "File has no content",
      };
    }

    const fileText = yield* Effect.either(getFileText(owner, repo, fileData));
    if (Either.isLeft(fileText)) {
      return getApiErrorResult(fileText.left, "File content not found in repository");
    }
    return checkHash(fullUrl, hash, content.path, fileText.right);
  });

/** The hash of a blob against its text: a code line or a heading */
const checkHash = (
  fullUrl: URL,
  hash: string,
  path: string,
  fileText: FileText,
): LinkCheckResult => {
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
    return !lineResult.ok && isRenderedMarkdown(path, fullUrl) && hasHeadingAnchor(fileText, hash)
      ? { ok: true, status: 200 }
      : lineResult;
  }

  if (hasHeadingAnchor(fileText, hash)) {
    return { ok: true, status: 200 };
  }

  return {
    ok: false,
    error: "hash not found",
    status: 200,
    errorDetail: `No heading found matching hash: ${hash}`,
  };
};

/**
 * Check if a GitHub branch/tag/commit (`tree/<ref>`) or a path in it (`tree/<ref>/<path>`) exists. The contents API
 * accepts a branch, tag or commit SHA as ref and an empty path (repository root).
 * @param owner - The owner of the repository
 * @param repo - The repository name
 * @param pathParts - The path parts of the URL
 * @returns - A LinkCheckResult object
 */
export const checkGitHubTreeLink = (
  owner: string,
  repo: string,
  pathParts: string[],
): Effect.Effect<LinkCheckResult, never, GitHubServices> =>
  Effect.gen(function* () {
    // The ref can contain slashes: `tree/feature/x/src` (see `getRefPathContent`)
    const [, ref = "", ...restOfPath] = pathParts;
    const path = restOfPath.join("/");
    const content = yield* getRefPathContent(owner, repo, pathParts.slice(1), {
      requirePath: false,
    });
    if (content.found) {
      return { ok: true, status: 200 };
    }
    return getApiErrorResult(
      content.error,
      path
        ? `Path ${path} not found in branch, tag or commit ${ref}`
        : `No branch, tag or commit ${ref} found in repository ${owner}/${repo}`,
    );
  });
