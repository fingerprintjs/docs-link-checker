import { describe, expect, it } from "vitest";
import type { LinkCheckResult } from "../types";
import {
  judgeLink,
  judgePage,
  type PageLoad,
  type PageVerdict,
  planRetry,
  shouldRecheckWithPlaywright,
} from "./verdict";

const PAGE_URL = "https://example.com/page";

/** A response load. Its body is "BODY", `bodyReads` counts how often it was read. */
const response = (
  status: number,
  { statusText = "Text", retryAfter = null as string | null } = {},
) => {
  const load = {
    type: "response" as const,
    status,
    statusText,
    retryAfter,
    bodyReads: 0,
    readBody: async () => {
      load.bodyReads++;
      return "BODY";
    },
  };
  return load;
};

const serverErrorDetail = (status: number) =>
  `Server error ${status} Text (overloaded or rate limiting), still failing after up to 2 retries BODY`;

describe("judgePage()", () => {
  type Row = [string, PageLoad, PageVerdict, PageVerdict];
  const ok = (status: number): PageVerdict => ({ ok: true, status });
  const fail = (result: LinkCheckResult): PageVerdict => ({ ok: false, result });
  const broken = (status: number) =>
    fail({ ok: false, error: "broken link", status, errorDetail: "Text BODY" });
  const couldNotCheck = (status: number, errorDetail = "Text BODY") =>
    fail({ ok: false, error: "could not check", status, errorDetail });
  // [name, load, fetch verdict, Playwright verdict]
  const rows: Row[] = [
    ["200", response(200), ok(200), ok(200)],
    ["201", response(201), ok(201), ok(201)],
    ["204", response(204), ok(204), ok(204)],
    ["299", response(299), ok(299), ok(299)],
    ["301 (redirect without Location)", response(301), ok(301), ok(301)],
    ["308", response(308), ok(308), ok(308)],
    ["300 (not a redirect that ends a request)", response(300), broken(300), broken(300)],
    ["404", response(404), broken(404), broken(404)],
    ["401", response(401), broken(401), couldNotCheck(401)],
    ["403", response(403), broken(403), couldNotCheck(403)],
    [
      "429 without Retry-After",
      response(429),
      couldNotCheck(429, "Rate limited, no Retry-After BODY"),
      couldNotCheck(429, "Rate limited, no Retry-After BODY"),
    ],
    [
      "429 with Retry-After (still limited after the retries, or asked to wait too long)",
      response(429, { retryAfter: "120" }),
      couldNotCheck(429, "Rate limited, gave up (Retry-After: 120) BODY"),
      couldNotCheck(429, "Rate limited, gave up (Retry-After: 120) BODY"),
    ],
    ["500 (not a transient server error)", response(500), broken(500), broken(500)],
    ...[502, 503, 504].map((status): Row => [
      `${status}`,
      response(status),
      couldNotCheck(status, serverErrorDetail(status)),
      couldNotCheck(status, serverErrorDetail(status)),
    ]),
    [
      "network error or timeout",
      { type: "error", error: new TypeError("fetch failed") },
      fail({ ok: false, error: "broken link", errorDetail: "TypeError: fetch failed" }),
      fail({ ok: false, error: "broken link", errorDetail: "TypeError: fetch failed" }),
    ],
    [
      "no response",
      { type: "no-response" },
      fail({ ok: false, error: "broken link", errorDetail: "No response" }),
      fail({ ok: false, error: "broken link", errorDetail: "No response" }),
    ],
  ];

  it.each(rows)(
    "%s: fetch and Playwright verdicts",
    async (_name, load, fetchVerdict, playwrightVerdict) => {
      expect(await judgePage("fetch", load)).toEqual(fetchVerdict);
      expect(await judgePage("playwright", load)).toEqual(playwrightVerdict);
    },
  );

  it("omits the status text from a server error detail when there is none", async () => {
    expect(await judgePage("fetch", response(503, { statusText: "" }))).toMatchObject({
      result: { errorDetail: expect.stringMatching(/^Server error 503 \(overloaded/) },
    });
  });

  it.each(["fetch", "playwright"] as const)(
    "%s: cuts a long error page body, keeps the start of it",
    async (checker) => {
      const body = `  <html>${"x".repeat(1000)}</html>`;
      const load = { ...response(404, { statusText: "" }), readBody: async () => body };

      const verdict = await judgePage(checker, load);

      expect(verdict).toMatchObject({ ok: false, result: { error: "broken link", status: 404 } });
      const detail = !verdict.ok && !verdict.result.ok ? verdict.result.errorDetail : undefined;
      expect(detail).toBe(`<html>${"x".repeat(494)}…`);
    },
  );

  it.each([
    ["fetch", 200, 0],
    ["fetch", 404, 1],
    ["fetch", 429, 1],
    ["playwright", 200, 0],
    ["playwright", 404, 1],
    ["playwright", 503, 1],
  ] as const)(
    "%s %s reads the body %s times (only for the detail)",
    async (checker, status, reads) => {
      const load = response(status);
      await judgePage(checker, load);
      expect(load.bodyReads).toBe(reads);
    },
  );
});

describe("planRetry()", () => {
  const none = { "rate-limited": 0, "server-error": 0 };
  const rateLimited = (delayMs: number) => ({ reason: "rate-limited", delayMs }) as const;
  const serverError = (delayMs: number) => ({ reason: "server-error", delayMs }) as const;
  type Row = [string, number, string | null, typeof none, ReturnType<typeof planRetry>];
  // The same for requests and Playwright navigations
  const rows: Row[] = [
    ["ok status", 200, null, none, undefined],
    ["404", 404, "5", none, undefined],
    ["500", 500, null, none, undefined],
    // Rate limits
    ["429 with Retry-After", 429, "3", none, rateLimited(3000)],
    ["429 with Retry-After of 79s", 429, "79", none, rateLimited(79_000)],
    ["429 with Retry-After of 80s", 429, "80", none, undefined],
    ["429 without Retry-After", 429, null, none, undefined],
    ["429 with invalid Retry-After", 429, "soon", none, undefined],
    ["429 after 2 retries", 429, "1", { ...none, "rate-limited": 2 }, undefined],
    ["429 after server error retries", 429, "1", { ...none, "server-error": 2 }, rateLimited(1000)],
    // Server errors
    ["502, first retry", 502, null, none, serverError(2000)],
    ["504, second retry", 504, null, { ...none, "server-error": 1 }, serverError(5000)],
    ["503 after 2 retries", 503, null, { ...none, "server-error": 2 }, undefined],
    ["503 with a longer Retry-After", 503, "8", none, serverError(8000)],
    [
      "503 with a shorter Retry-After (backoff is the minimum)",
      503,
      "1",
      { ...none, "server-error": 1 },
      serverError(5000),
    ],
    [
      "503 with Retry-After of exactly 10s",
      503,
      "10",
      { ...none, "server-error": 1 },
      serverError(10_000),
    ],
    ["503 with Retry-After over 10s", 503, "11", none, undefined],
    ["503 with invalid Retry-After", 503, "soon", none, serverError(2000)],
  ];

  it.each(rows)("%s", (...[, status, retryAfter, retries, plan]: Row) => {
    expect(planRetry({ status, retryAfter }, retries)).toEqual(plan);
  });

  it("accepts Retry-After as an HTTP date", () => {
    const inFiveSeconds = new Date(Date.now() + 5500).toUTCString();
    const plan = planRetry({ status: 429, retryAfter: inFiveSeconds }, none);
    expect(plan?.reason).toBe("rate-limited");
    expect(plan?.delayMs).toBeGreaterThan(4000);
    expect(plan?.delayMs).toBeLessThanOrEqual(5500);
  });
});

describe("judgeLink()", () => {
  const okPage: PageVerdict = { ok: true, status: 200 };
  const brokenPage: PageVerdict = {
    ok: false,
    result: { ok: false, error: "broken link", status: 404 },
  };
  const found = () => true;
  const missing = () => false;

  type Row = [
    string,
    string,
    PageVerdict,
    (fragment: string) => boolean,
    string | undefined,
    LinkCheckResult,
  ];
  const rows: Row[] = [
    ["no hash", PAGE_URL, okPage, missing, undefined, { ok: true, status: 200 }],
    ["hash found", `${PAGE_URL}#a`, okPage, found, undefined, { ok: true, status: 200 }],
    [
      "hash missing",
      `${PAGE_URL}#a`,
      okPage,
      missing,
      undefined,
      { ok: false, status: 200, error: "hash not found" },
    ],
    [
      "text fragment",
      `${PAGE_URL}#:~:text=hi`,
      okPage,
      missing,
      undefined,
      { ok: true, status: 200, note: "Text Fragment" },
    ],
    [
      "accidental hash",
      `${PAGE_URL}#/`,
      okPage,
      missing,
      undefined,
      { ok: true, status: 200, note: "Accidental hash" },
    ],
    [
      "failed page",
      `${PAGE_URL}#a`,
      brokenPage,
      found,
      undefined,
      { ok: false, error: "broken link", status: 404 },
    ],
    [
      "failed page after a redirect",
      PAGE_URL,
      brokenPage,
      found,
      "https://example.com/new",
      { ok: false, error: "broken link", status: 404, redirectedTo: "https://example.com/new" },
    ],
    [
      "hash missing after a redirect",
      `${PAGE_URL}#a`,
      okPage,
      missing,
      "https://example.com/new",
      { ok: false, status: 200, error: "hash not found", redirectedTo: "https://example.com/new" },
    ],
    [
      "special fragment after a redirect",
      `${PAGE_URL}#/`,
      okPage,
      missing,
      "https://example.com/new",
      { ok: true, status: 200, note: "Accidental hash", redirectedTo: "https://example.com/new" },
    ],
  ];

  it.each(rows)("%s", async (...[, url, page, isHashPresent, redirectedTo, result]: Row) => {
    expect(await judgeLink(url, page, { redirectedTo, isHashPresent })).toEqual(result);
  });

  it("looks for the hash without `#`, only when there is one to look for", async () => {
    const asked: string[] = [];
    const isHashPresent = (fragment: string) => {
      asked.push(fragment);
      return true;
    };
    await judgeLink(`${PAGE_URL}#caf%C3%A9`, okPage, { isHashPresent });
    await judgeLink(PAGE_URL, okPage, { isHashPresent });
    await judgeLink(`${PAGE_URL}#/`, okPage, { isHashPresent });
    await judgeLink(`${PAGE_URL}#a`, brokenPage, { isHashPresent });
    expect(asked).toEqual(["caf%C3%A9"]);
  });
});

describe("shouldRecheckWithPlaywright()", () => {
  const broken = (status?: number): LinkCheckResult => ({
    ok: false,
    error: "broken link",
    status,
  });
  type Row = [string, LinkCheckResult, boolean, boolean];
  // [name, first-pass result, re-checked after fetch, re-checked after the GitHub API]
  const rows: Row[] = [
    ["ok", { ok: true, status: 200 }, false, false],
    ["broken 404", broken(404), false, false],
    ["broken 410", broken(410), false, false],
    ["broken 400", broken(400), false, false],
    ...[401, 403, 405, 406, 408].map((status): Row => [
      `broken ${status}`,
      broken(status),
      true,
      false,
    ]),
    ["broken 500", broken(500), true, false],
    ["broken 501", broken(501), true, false],
    ["broken without status (network error, timeout)", broken(), true, false],
    ["hash not found", { ok: false, error: "hash not found", status: 200 }, true, false],
    ["could not check", { ok: false, error: "could not check", status: 503 }, true, false],
    ["rate limited", { ok: false, error: "could not check", status: 429 }, true, false],
    ["unexpected error", { ok: false, error: "unexpected error", status: 429 }, true, true],
  ];

  it.each(rows)(
    "%s: re-checked after fetch and after the GitHub API",
    (_name, result, afterFetch, afterApi) => {
      expect(shouldRecheckWithPlaywright("fetch", result)).toBe(afterFetch);
      expect(shouldRecheckWithPlaywright("github-api", result)).toBe(afterApi);
    },
  );
});
