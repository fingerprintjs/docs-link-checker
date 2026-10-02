/** HTTP status of an error with a numeric `status` (Octokit `RequestError`), `undefined` for other errors */
export const getErrorStatus = (error: unknown): number | undefined =>
  typeof error === "object" &&
  error !== null &&
  "status" in error &&
  typeof error.status === "number"
    ? error.status
    : undefined;

/** Message of an `Error`, the string form of anything else that was thrown */
export const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
