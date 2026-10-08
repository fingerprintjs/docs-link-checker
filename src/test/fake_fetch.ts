/**
 * Fake `Fetch` for tests: the handler answers requests, every call is recorded.
 */
import { Layer } from "effect";
import { Fetch, type FetchFn } from "../http";

export type FetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>;

/**
 * Like the real `fetch`, a request rejects with an `AbortError` when `init.signal` aborts, so timeouts and
 * interruption can be tested. A handler that never settles simulates a hanging server.
 */
export const fakeFetch = (handler: FetchHandler) => {
  const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
  const fetch: FetchFn = (url, init) => {
    calls.push({ url, init });
    return new Promise<Response>((resolve, reject) => {
      const { signal } = init;
      const abort = () => reject(new DOMException("This operation was aborted", "AbortError"));
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      Promise.resolve()
        .then(() => handler(url, init))
        .then(resolve, reject);
    });
  };
  return { layer: Layer.succeed(Fetch, fetch), calls };
};
