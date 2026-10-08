/**
 * Typed errors of the Effect-based core (`Data.TaggedError`): handle them by tag with `Effect.catchTag`.
 * https://effect.website/docs/error-management/expected-errors/
 */
import { Data } from "effect";

/** Message of an `Error`, the string form of anything else that was thrown */
export const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A request failed before a response arrived (DNS, connection, TLS...) or while reading it */
export class FetchError extends Data.TaggedError("FetchError")<{
  readonly url: string;
  readonly cause: unknown;
}> {
  override get message() {
    return getErrorMessage(this.cause);
  }

  // Reports show the same text as the original fetch error ("TypeError: fetch failed")
  override toString() {
    return String(this.cause);
  }
}

/** An operation did not finish in time. It is interrupted, so its request or navigation is cancelled. */
export class TimeoutError extends Data.TaggedError("TimeoutError")<{
  readonly message: string;
  readonly timeoutMs: number;
}> {}

export class TooManyRedirects extends Data.TaggedError("TooManyRedirects")<{
  readonly url: string;
  readonly maxRedirects: number;
}> {
  override get message() {
    return `Too many redirects (more than ${this.maxRedirects}) for ${this.url}`;
  }
}

/** The shared browser could not be launched */
export class BrowserLaunchError extends Data.TaggedError("BrowserLaunchError")<{
  readonly cause: unknown;
}> {
  override get message() {
    return getErrorMessage(this.cause);
  }
}
