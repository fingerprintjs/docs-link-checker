import { tryCatch } from "../utils/tryCatch";
import { isNotFoundApiError } from "./gh_api_error";
import { type ContentResponse, getContentCached, getMatchingRefsCached } from "./gh_cache";

/**
 * Names of the branches and tags that start with the first segment of a `<ref>/<path>` URL part and could be the ref
 * (`feature` or `feature/...`, not `feature-2`), one cached listing of branches and one of tags per repository and
 * first segment. A missing repository has no refs.
 */
const getRefCandidates = async (owner: string, repo: string, first: string): Promise<string[]> => {
  const listings = await Promise.all(
    (["heads", "tags"] as const).map(async (kind) => {
      const { data, error } = await tryCatch(
        getMatchingRefsCached(owner, repo, `${kind}/${first}`),
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
  return [...new Set(listings.flat())].filter(
    (name) => name === first || name.startsWith(`${first}/`),
  );
};

export type RefPathContent =
  | {
      found: true;
      ref: string;
      path: string;
      /** Contents API response, `undefined` if the URL is only a ref (proven by the ref listing) */
      response: ContentResponse | undefined;
    }
  | { found: false; error: unknown };

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
export const getRefPathContent = async (
  owner: string,
  repo: string,
  segments: string[],
  { requirePath }: { requirePath: boolean },
): Promise<RefPathContent> => {
  const [first = "", ...rest] = segments;
  const path = rest.join("/");
  const firstTry = await tryCatch(getContentCached({ owner, repo, ref: first, path }));
  if (firstTry.data) {
    return { found: true, ref: first, path, response: firstTry.data };
  }
  if (!isNotFoundApiError(firstTry.error) || segments.length < 2) {
    return { found: false, error: firstTry.error };
  }

  const { data: candidates, error: listError } = await tryCatch(
    getRefCandidates(owner, repo, first),
  );
  if (listError) {
    return { found: false, error: listError };
  }
  const maxRefSegments = segments.length - (requirePath ? 1 : 0);
  const candidateRefs = new Set(candidates);
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
      return { found: true, ref, path: refPath, response: undefined };
    }
    const { data, error } = await tryCatch(getContentCached({ owner, repo, ref, path: refPath }));
    if (data) {
      return { found: true, ref, path: refPath, response: data };
    }
    if (!isNotFoundApiError(error)) {
      return { found: false, error };
    }
  }
  return { found: false, error: firstTry.error };
};
