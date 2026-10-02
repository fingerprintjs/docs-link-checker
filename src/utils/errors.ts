/** Message of an `Error`, the string form of anything else that was thrown */
export const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
