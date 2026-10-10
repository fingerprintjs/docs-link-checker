// Types for the result object with discriminated union
type Success<T> = {
  data: T;
  error: null;
};

type Failure = {
  data: null;
  // Octokit errors keep their `status`, read it with `getApiErrorStatus` (see github/api.ts)
  error: Error;
};

type Result<T> = Success<T> | Failure;

// Main wrapper function
export async function tryCatch<T>(promise: Promise<T>): Promise<Result<T>> {
  try {
    const data = await promise;
    return { data, error: null };
  } catch (error) {
    // Anything can be thrown, wrap non-errors so `error` is always truthy and has a message
    return {
      data: null,
      error: error instanceof Error ? error : new Error(String(error), { cause: error }),
    };
  }
}
