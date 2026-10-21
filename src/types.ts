export type Link = {
  page: string;
  href: string;
  text: string;
  /** Line of the link in the page (local files only) */
  line?: number;
};

export type LinkWithResult = Link & { result: LinkCheckResult };

/** Result of a link check. Which response or error gets which `error` is decided in `check/verdict.ts`. */
export type LinkCheckResult =
  | {
      ok: true;
      status: number;
      note?: string;
      /** Final URL when the checked URL redirected to a different page (not for trailing slash or hash changes) */
      redirectedTo?: string;
    }
  | {
      ok: false;
      error:
        // The reader can't reach the target: 404 or another failed status, or a network error or timeout that
        // persists in the browser re-check (no `status`, reported as "Network error")
        | "broken link"
        // The page works but the anchor hash is not found on it
        | "hash not found"
        // The checker itself failed (API error, check timeout, a check that threw). Counted as a link to fix.
        | "unexpected error"
        // We can't tell: bot blocking or a login (401, 403), rate limiting (429), a server error (502, 503, 504)
        // persisting after retries. Not counted as a link to fix.
        | "could not check";
      status?: number;
      errorDetail?: string;
      /** Final URL when the checked URL redirected to a different page (not for trailing slash or hash changes) */
      redirectedTo?: string;
    };
