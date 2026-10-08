import { afterAll, describe, expect, it } from "vitest";
import { checkLinkWithFetch } from "./fetch_check";
import { checkLinks } from "./link";
import {
  checkUrlsOnPageWithPlaywright,
  HASH_FALLBACK_WAIT_TIMEOUT,
  HASH_WAIT_TIMEOUT,
  PAGE_OPERATION_TIMEOUT,
} from "./playwright_check";
import { closeRunBrowser, getRunContext, withRun } from "./run";

const checkLinkWithPlaywright = async (url: string) =>
  (await checkUrlsOnPageWithPlaywright([url])).get(url)!;

// Checks outside of a run share one browser, close it when done
afterAll(closeRunBrowser);

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
  {
    function: checkLinkWithFetch,
    name: "checkLinkWithFetch()",
  },
  {
    function: checkLinkWithPlaywright,
    name: "checkLinkWithPlaywright()",
  },
];

for (const { function: checkLink, name } of linkCheckMethods) {
  describe(name, () => {
    /**
     * Simple response checks
     */
    it(`${name} should return OK for working links`, async () => {
      const result = await checkLink("https://www.google.com");
      expect(result).toMatchObject({ ok: true, status: 200 });
    });

    it(`${name} should return broken link for 404 links`, async () => {
      const result = await checkLink("https://www.google.com/does/not/exist");
      expect(result).toMatchObject({ ok: false, error: "broken link", status: 404 });
    });

    it(`${name} should return broken link for malformed URLS`, async () => {
      const result = await checkLink("ttps://www.google.com");
      expect(result).toMatchObject({
        ok: false,
        error: "broken link",
        errorDetail: expect.any(String),
      });
    });

    /**
     * Hashes
     */
    it(`${name} should return OK for hashes that exist (server-rendered)`, async () => {
      const result = await checkLink(
        "https://fingerprint.com/blog/browser-fingerprinting-techniques/#how-does-browser-fingerprinting-work",
      );
      expect(result).toMatchObject({ ok: true, status: 200 });
    });

    it(
      `${name} should return 'hash not found' for broken hash links (server-rendered)`,
      {
        timeout: HASH_CHECK_TEST_TIMEOUT,
      },
      async () => {
        const result = await checkLink("https://fingerprint.com#does-not-exist");
        expect(result).toMatchObject({ ok: false, status: 200, error: "hash not found" });
      },
    );

    it(`${name} should return OK for hashes implemented using 'href', like on GitHub`, async () => {
      const result = await checkLink(
        "https://github.com/fingerprintjs/fingerprintjs?tab=readme-ov-file#installation",
      );
      expect(result).toMatchObject({ ok: true, status: 200 });
    });

    it(`${name} should return OK for hashes implemented using 'href', like on GitHub, even despite different casing`, async () => {
      const result = await checkLink(
        "https://github.com/fingerprintjs/fingerprintjs?tab=readme-ov-file#InStAlLaTiOn",
      );
      expect(result).toMatchObject({ ok: true, status: 200 });
    });

    it(`${name} should return OK and ignore accidental hashes that Readme creates 🤦`, async () => {
      const result = await checkLink("https://dev.fingerprint.com/docs/quick-start-guide#/");
      expect(result).toMatchObject({ ok: true, status: 200 });
    });

    /**
     * Text fragments
     */
    it(`${name} should return OK for links with text fragment`, async () => {
      const result = await checkLink(
        "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/a#:~:text=human",
      );
      expect(result).toMatchObject({ ok: true, status: 200, note: "Text Fragment" });
    });

    // Skipping this edge case for
    it(`${name} should return OK for links with text fragment, even if its not there`, async () => {
      const result = await checkLink(
        "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/a#:~:text=IS_NOT_THERE_DKSOAPD",
      );
      expect(result).toMatchObject({ ok: true, status: 200, note: "Text Fragment" });
    });
  });
}

describe("checkLinkWithPlaywright()", () => {
  it("should return OK for hashes that exist (client-rendered)", async () => {
    const result = await checkLinkWithPlaywright(
      "https://developer.apple.com/documentation/webkit#overview",
    );
    expect(result).toEqual({ ok: true, status: 200 });
  });

  it(
    "should return 'hash not found' for broken hash links (client-rendered)",
    {
      timeout: HASH_CHECK_TEST_TIMEOUT,
    },
    async () => {
      const result = await checkLinkWithPlaywright(
        "https://developer.apple.com/documentation/webkit#this-hash-does-not-exist",
      );
      expect(result).toEqual({ ok: false, status: 200, error: "hash not found" });
    },
  );

  it(
    "should return OK for anchors rendered late (Mintlify expands nested fields on hash navigation)",
    {
      timeout: HASH_CHECK_TEST_TIMEOUT,
    },
    async () => {
      const result = await checkLinkWithPlaywright(
        "https://docs.fingerprint.com/reference/server-api-get-event#response-ip-info-v6-address",
      );
      expect(result).toEqual({ ok: true, status: 200 });
    },
  );
});

// GitHub code line links (`#L12`) are checked with the GitHub API (github.com refuses blob pages to headless browsers on
// CI runners with 503), never in the browser. Needs GH_TOKEN.
describe("checkLinks() GitHub code line links", () => {
  it(
    "checks the lines against the file from the GitHub API, without a browser navigation",
    {
      // A few API requests (Octokit retries server errors itself)
      timeout: 60000,
    },
    async () => {
      const file = "https://github.com/fingerprintjs/fingerprintjs/blob/master/package.json";
      const links = ["#L3", "#L3-L5", "#L99999", "#L8888-L9999"].map((hash) => ({
        page: "https://example.com/",
        href: `${file}${hash}`,
        text: "link",
      }));

      const { results, metrics } = await withRun({}, async () => {
        const checked = await checkLinks({ links });
        return { results: checked, metrics: { ...getRunContext()!.metrics.counters } };
      });

      const resultFor = (hash: string) => results.find((r) => r.href === `${file}${hash}`)?.result;
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
      expect(metrics.playwrightNavigations ?? 0).toBe(0);
      // One request for the file, shared by all its line hashes
      expect(metrics.githubApiRequests).toBe(1);
    },
  );
});
