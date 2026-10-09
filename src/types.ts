export type Link = {
  page: string;
  href: string;
  text: string;
  /** Line of the link in the page (local files only) */
  line?: number;
};

export type LinkWithResult = Link & { result: LinkCheckResult };

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
        | "broken link" // 404 or some other non-successful response code
        | "hash not found" // Link works but the anchor hash is not found on the page
        | "unexpected error" // Fetch failed, server completely dead, wrong protocol, etc.
        // Recaptcha or other anti-scraping measures returning 403, 401 or the link requires a login,
        // or a server error (502, 503, 504) persisting after retries
        | "could not check";
      status?: number;
      errorDetail?: string;
      /** Final URL when the checked URL redirected to a different page (not for trailing slash or hash changes) */
      redirectedTo?: string;
    };
