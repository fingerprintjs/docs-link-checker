import { vi } from "vitest";
import type { GithubApi } from "./client";

/**
 * Fake GitHub API for offline tests, injected through the run (`withRun({ deps: { octokit: () => api } })`).
 * Every method is a `vi.fn` typed against `GithubApi`: a fake response that no longer matches what the app reads
 * fails tsc. By default every resource exists, tests override the methods they care about.
 */

type WithSignal = { request?: { signal?: AbortSignal } };

/** A failed request like Octokit's `RequestError` (`status` is `undefined` for a network error) */
export const apiError = (status: number | undefined, message = `HTTP ${status}`) =>
  Object.assign(new Error(message), { status });

export const notFound = () => apiError(404, "Not Found");

/** GraphQL answers a missing repository or discussion with errors in a 200 response */
export const graphqlError = (message: string, type?: string) =>
  Object.assign(new Error(message), { errors: [{ type, message }] });

/** A file of the contents API, `sha` identifies its blob (see `largeFileContent`) */
export const fileContent = (text: string | Buffer, sha = "sha") => ({
  data: {
    type: "file",
    sha,
    size: Buffer.from(text).length,
    content: Buffer.from(text).toString("base64"),
    encoding: "base64",
  },
});

/** A file over 1 MB: the contents API sends no content, the blob API does */
export const largeFileContent = (size: number, sha = "bigsha") => ({
  data: { type: "file", sha, size, content: "", encoding: "none" },
});

export const directoryContent = () => ({
  data: [{ type: "file", sha: "sha", content: undefined }],
});

/**
 * Like a real request: answers `value` after `ms`, or rejects as soon as the signal of the request aborts.
 * `aborted` lists the requests that were aborted.
 */
export const answerAfter = <T>(ms: number, value: T) => {
  const aborted: unknown[] = [];
  const answer = (params: WithSignal) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => resolve(value), ms);
      params.request?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        aborted.push(params);
        reject(new Error("aborted"));
      });
    });
  return Object.assign(answer, { aborted });
};

const respond = <T>(response: T) => Promise.resolve(response);

export const createFakeGithubApi = () =>
  ({
    users: {
      getByUsername: vi.fn<GithubApi["users"]["getByUsername"]>(() => respond({ data: {} })),
    },
    repos: {
      get: vi.fn<GithubApi["repos"]["get"]>(() => respond({ data: { default_branch: "main" } })),
      getContent: vi.fn<GithubApi["repos"]["getContent"]>(() => respond(fileContent(""))),
      getCommit: vi.fn<GithubApi["repos"]["getCommit"]>(() => respond({ data: {} })),
      getRelease: vi.fn<GithubApi["repos"]["getRelease"]>(() => respond({ data: {} })),
      getReleaseByTag: vi.fn<GithubApi["repos"]["getReleaseByTag"]>(() =>
        respond({
          data: { assets: [] },
        }),
      ),
      getLatestRelease: vi.fn<GithubApi["repos"]["getLatestRelease"]>(() => respond({ data: {} })),
      listReleases: vi.fn<GithubApi["repos"]["listReleases"]>(() => respond({ data: [{}] })),
      listForOrg: vi.fn<GithubApi["repos"]["listForOrg"]>(() => respond({ data: [] })),
    },
    issues: { get: vi.fn<GithubApi["issues"]["get"]>(() => respond({ data: {} })) },
    pulls: { get: vi.fn<GithubApi["pulls"]["get"]>(() => respond({ data: {} })) },
    git: {
      getBlob: vi.fn<GithubApi["git"]["getBlob"]>(() => respond({ data: { content: "" } })),
      listMatchingRefs: vi.fn<GithubApi["git"]["listMatchingRefs"]>(() => respond({ data: [] })),
      getTree: vi.fn<GithubApi["git"]["getTree"]>(() => respond({ data: { tree: [] } })),
    },
    graphql: vi.fn<GithubApi["graphql"]>(() =>
      respond({
        repository: { discussion: { id: "D_1" } },
      }),
    ),
    // A single page: the fakes answer the whole list at once
    paginate: async <P, T>(route: (params: P) => Promise<{ data: T[] }>, params: P) =>
      (await route(params)).data,
  }) satisfies GithubApi;

export type FakeGithubApi = ReturnType<typeof createFakeGithubApi>;
