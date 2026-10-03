export type Link = {
  page: string;
  href: string;
  text: string;
  /** Line of the link in the page (local files only) */
  line?: number;
};

/** How the final result of a link was decided, see `CheckMethod` and `shouldRecheckWithPlaywright` in `src/link.ts` */
export type CheckedWith = "fetch" | "github-api" | "playwright";

export type LinkWithResult = Link & { result: LinkCheckResult; checkedWith?: CheckedWith };

export type LinkCheckResult =
  | {
      ok: true;
      status: number;
      note?: string;
    }
  | {
      ok: false;
      error:
        | "broken link" // 404 or some other non-successful response code
        | "hash not found" // Link works but the anchor hash is not found on the page
        | "unexpected error" // Fetch failed, server completely dead, wrong protocol, etc.
        // Recaptcha or other anti-scraping measures returning 403, 401 or the link requires a login,
        // a server error (502, 503, 504) persisting after retries, or a blocked destination
        | "could not check";
      status?: number;
      errorDetail?: string;
      /** The destination is a private or local address (see `src/destination.ts`), it was never requested */
      destinationBlocked?: boolean;
    };
