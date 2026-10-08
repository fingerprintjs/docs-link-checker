/**
 * Checks real websites with the fetch and Playwright methods (needs network, a Chromium and `GH_TOKEN`).
 * Run with `pnpm test:integration`.
 */
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { liveRunLayer, type RunServices } from "./app";
import { DEFAULT_HOST_CONCURRENCY } from "./config";
import { checkLinkWithFetch } from "./fetch_check";
import { checkLinks } from "./link";
import { Metrics } from "./metrics";
import {
  checkUrlsOnPageWithPlaywright,
  HASH_FALLBACK_WAIT_TIMEOUT,
  HASH_WAIT_TIMEOUT,
  PAGE_OPERATION_TIMEOUT,
} from "./playwright_check";

// Every test is its own run: own metrics and browser
const live = <A, E>(effect: Effect.Effect<A, E, RunServices>) =>
  effect.pipe(Effect.provide(liveRunLayer({ hostConcurrency: DEFAULT_HOST_CONCURRENCY })));

const checkLinkWithPlaywright = (url: string) =>
  checkUrlsOnPageWithPlaywright([url]).pipe(Effect.map((results) => results.get(url)));

// Retries of a navigation answered with 502/503/504 (GitHub under load): up to 2 retries, each waiting at most 10s
// (see http.ts), plus the navigation
const SERVER_ERROR_RETRY_TIME = 2 * (10000 + PAGE_OPERATION_TIMEOUT);

// Worst case of a missing anchor: the navigation (and its retries), then the late anchor wait (a missing GitHub code
// line: the wait for the code view plus the wait for the line), plus a margin
const HASH_CHECK_TEST_TIMEOUT =
  PAGE_OPERATION_TIMEOUT +
  SERVER_ERROR_RETRY_TIME +
  HASH_FALLBACK_WAIT_TIMEOUT +
  HASH_WAIT_TIMEOUT +
  10000;

const linkCheckMethods = [
  { check: (url: string) => checkLinkWithFetch(url), name: "checkLinkWithFetch()" },
  { check: checkLinkWithPlaywright, name: "checkLinkWithPlaywright()" },
];

for (const { check, name } of linkCheckMethods) {
  describe(name, () => {
    /**
     * Simple response checks
     */
    it.live(`${name} should return OK for working links`, () =>
      live(
        Effect.gen(function* () {
          expect(yield* check("https://www.google.com")).toMatchObject({ ok: true, status: 200 });
        }),
      ),
    );

    it.live(`${name} should return broken link for 404 links`, () =>
      live(
        Effect.gen(function* () {
          expect(yield* check("https://www.google.com/does/not/exist")).toMatchObject({
            ok: false,
            error: "broken link",
            status: 404,
          });
        }),
      ),
    );

    /**
     * Hashes
     */
    it.live(`${name} should return OK for hashes that exist (server-rendered)`, () =>
      live(
        Effect.gen(function* () {
          const result = yield* check(
            "https://fingerprint.com/blog/browser-fingerprinting-techniques/#how-does-browser-fingerprinting-work",
          );
          expect(result).toMatchObject({ ok: true, status: 200 });
        }),
      ),
    );

    it.live(
      `${name} should return 'hash not found' for broken hash links (server-rendered)`,
      () =>
        live(
          Effect.gen(function* () {
            const result = yield* check("https://fingerprint.com#does-not-exist");
            expect(result).toMatchObject({ ok: false, status: 200, error: "hash not found" });
          }),
        ),
      HASH_CHECK_TEST_TIMEOUT,
    );

    it.live(`${name} should return OK for hashes implemented using 'href', like on GitHub`, () =>
      live(
        Effect.gen(function* () {
          const result = yield* check(
            "https://github.com/fingerprintjs/fingerprintjs?tab=readme-ov-file#installation",
          );
          expect(result).toMatchObject({ ok: true, status: 200 });
        }),
      ),
    );

    it.live(
      `${name} should return OK for hashes implemented using 'href', like on GitHub, even despite different casing`,
      () =>
        live(
          Effect.gen(function* () {
            const result = yield* check(
              "https://github.com/fingerprintjs/fingerprintjs?tab=readme-ov-file#InStAlLaTiOn",
            );
            expect(result).toMatchObject({ ok: true, status: 200 });
          }),
        ),
    );
  });
}

describe("checkLinkWithPlaywright()", () => {
  it.live("should return OK for hashes that exist (client-rendered)", () =>
    live(
      Effect.gen(function* () {
        const result = yield* checkLinkWithPlaywright(
          "https://developer.apple.com/documentation/webkit#overview",
        );
        expect(result).toEqual({ ok: true, status: 200 });
      }),
    ),
  );

  it.live(
    "should return 'hash not found' for broken hash links (client-rendered)",
    () =>
      live(
        Effect.gen(function* () {
          const result = yield* checkLinkWithPlaywright(
            "https://developer.apple.com/documentation/webkit#this-hash-does-not-exist",
          );
          expect(result).toEqual({ ok: false, status: 200, error: "hash not found" });
        }),
      ),
    HASH_CHECK_TEST_TIMEOUT,
  );

  it.live(
    "should return OK for anchors rendered late (Mintlify expands nested fields on hash navigation)",
    () =>
      live(
        Effect.gen(function* () {
          const result = yield* checkLinkWithPlaywright(
            "https://docs.fingerprint.com/reference/server-api-get-event#response-ip-info-v6-address",
          );
          expect(result).toEqual({ ok: true, status: 200 });
        }),
      ),
    HASH_CHECK_TEST_TIMEOUT,
  );
});

// GitHub code line links (`#L12`) are checked with the GitHub API (github.com refuses blob pages to headless browsers on
// CI runners with 503), never in the browser. Needs GH_TOKEN.
describe("checkLinks() GitHub code line links", () => {
  it.live(
    "checks the lines against the file from the GitHub API, without a browser navigation",
    () =>
      live(
        Effect.gen(function* () {
          const file = "https://github.com/fingerprintjs/fingerprintjs/blob/master/package.json";
          const links = ["#L3", "#L3-L5", "#L99999", "#L8888-L9999"].map((hash) => ({
            page: "https://example.com/",
            href: `${file}${hash}`,
            text: "link",
          }));

          const results = yield* checkLinks({ links });
          const { counters } = yield* (yield* Metrics).snapshot;

          const resultFor = (hash: string) =>
            results.find((r) => r.href === `${file}${hash}`)?.result;
          expect(resultFor("#L3")).toEqual({ ok: true, status: 200 });
          expect(resultFor("#L3-L5")).toEqual({ ok: true, status: 200 });
          expect(resultFor("#L99999")).toMatchObject({
            ok: false,
            status: 200,
            error: "hash not found",
          });
          expect(resultFor("#L8888-L9999")).toMatchObject({
            ok: false,
            status: 200,
            error: "hash not found",
          });
          expect(counters.playwrightNavigations ?? 0).toBe(0);
        }),
      ),
    // A few API requests (Octokit retries server errors itself)
    60000,
  );
});
