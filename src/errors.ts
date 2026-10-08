/**
 * Typed errors of the tool. Expected failures are values in the `E` channel of effects, not exceptions.
 * Exit codes of the CLI: `UsageError` and `BaselineError` are 2, everything else that escapes is 1.
 */
import { Data } from "effect";

/** Message of an `Error`, the string form of anything else that was thrown */
export const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A request failed before a response was complete: network error, timeout, aborted body */
export class FetchError extends Data.TaggedError("FetchError")<{
  readonly url: string;
  readonly cause: unknown;
}> {
  override get message() {
    return getErrorMessage(this.cause);
  }
  // Reports show "TypeError: fetch failed", like the raw fetch error did
  override toString() {
    return String(this.cause);
  }
}

export class TooManyRedirects extends Data.TaggedError("TooManyRedirects")<{
  readonly url: string;
  readonly maxRedirects: number;
}> {
  override get message() {
    return `Too many redirects (more than ${this.maxRedirects}) for ${this.url}`;
  }
  // Reports show "Error: Too many redirects ...", like the plain `Error` did
  override toString() {
    return `Error: ${this.message}`;
  }
}

/** Callers pass the full message ("Could not fetch X, status: N") */
export class HttpStatusError extends Data.TaggedError("HttpStatusError")<{
  readonly url: string;
  readonly status: number;
  readonly message: string;
}> {}

export class GitHubApiError extends Data.TaggedError("GitHubApiError")<{
  readonly status: number | undefined;
  readonly cause: unknown;
}> {
  get isNotFound() {
    return this.status === 404 || this.status === 410;
  }
  override get message() {
    return getErrorMessage(this.cause);
  }
  override toString() {
    return String(this.cause);
  }
}

/**
 * Not a link result: it fails the check ("unexpected error", no Playwright re-check).
 * A timeout says nothing about the link and a rate limited run should not hammer the site with a browser.
 */
export class GitHubTimeout extends Data.TaggedError("GitHubTimeout")<{
  readonly message: string;
}> {}

export class OrgListError extends Data.TaggedError("OrgListError")<{
  readonly org: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `Failed to list repositories of GitHub organization ${this.org}: ${getErrorMessage(this.cause)}`;
  }
}

export class BrowserLaunchError extends Data.TaggedError("BrowserLaunchError")<{
  readonly cause: unknown;
}> {
  override get message() {
    return getErrorMessage(this.cause);
  }
}

export class PlaywrightError extends Data.TaggedError("PlaywrightError")<{
  readonly cause: unknown;
}> {
  override get message() {
    return getErrorMessage(this.cause);
  }
}

export class NoMarkdownFiles extends Data.TaggedError("NoMarkdownFiles")<{
  readonly patterns: ReadonlyArray<string>;
}> {
  override get message() {
    return `No markdown files match ${this.patterns.map((pattern) => `"${pattern}"`).join(", ")}.`;
  }
}

/** Exit code 2 */
export class UsageError extends Data.TaggedError("UsageError")<{ readonly message: string }> {}

/** Exit code 2 */
export class BaselineError extends Data.TaggedError("BaselineError")<{
  readonly message: string;
}> {}
