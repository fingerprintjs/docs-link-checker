import { describe, it, expect, vi, assert, beforeAll } from "vitest";
import { checkLinkWithFetch, checkLinkWithPlaywright } from "./link";

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
      expect(result).toMatchObject({ ok: false, error: "broken link", errorDetail: expect.any(String) });
    });

    /**
     * Hashes
     */
    it(`${name} should return OK for hashes that exist (server-rendered)`, async () => {
      const result = await checkLink(
        "https://fingerprint.com/blog/android-device-reputation-network-fraud-detection#api-responses"
      );
      expect(result).toMatchObject({ ok: true, status: 200 });
    });

    it(
      `${name} should return 'hash not found' for broken hash links (server-rendered)`,
      { timeout: 10000 },
      async () => {
        const result = await checkLink("https://fingerprint.com#does-not-exist");
        expect(result).toMatchObject({ ok: false, status: 200, error: "hash not found" });
      }
    );

    it(`${name} should return OK for hashes implemented using 'href', like on GitHub`, async () => {
      const result = await checkLink(
        "https://github.com/fingerprintjs/fingerprintjs?tab=readme-ov-file#getting-started"
      );
      expect(result).toMatchObject({ ok: true, status: 200 });
    });

    it(`${name} should return OK for hashes implemented using 'href', like on GitHub, even despite different casing`, async () => {
      const result = await checkLink(
        "https://github.com/fingerprintjs/fingerprintjs?tab=readme-ov-file#GeTTing-StArteD"
      );
      expect(result).toMatchObject({ ok: true, status: 200 });
    });

    it(
      `${name} should return 'hash not found' for broken L{number} hashes on GitHub `,
      { timeout: 10000 },
      async () => {
        const result = await checkLink(
          "https://github.com/fingerprintjs/fingerprintjs/blob/master/package.json#L99999"
        );
        expect(result).toMatchObject({ ok: false, status: 200, error: "hash not found" });
      }
    );

    it(
      `${name} should return 'hash not found' for broken L{number}-L{number} hashes on GitHub `,
      { timeout: 10000 },
      async () => {
        const result = await checkLink(
          "https://github.com/fingerprintjs/fingerprintjs/blob/master/package.json#L8888-L9999"
        );
        expect(result).toMatchObject({ ok: false, status: 200, error: "hash not found" });
      }
    );

    it(`${name} should return OK and ignore accidental hashes that Readme creates 🤦`, async () => {
      const result = await checkLink("https://dev.fingerprint.com/docs/quick-start-guide#/");
      expect(result).toMatchObject({ ok: true, status: 200 });
    });

    /**
     * Text fragments
     */
    it(`${name} should return OK for links with text fragment`, async () => {
      const result = await checkLink("https://developer.mozilla.org/en-US/docs/Web/HTML/Element/a#:~:text=human");
      expect(result).toMatchObject({ ok: true, status: 200, note: "Text Fragment" });
    });

    // Skipping this edge case for
    it(`${name} should return OK for links with text fragment, even if its not there`, async () => {
      const result = await checkLink(
        "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/a#:~:text=IS_NOT_THERE_DKSOAPD"
      );
      expect(result).toMatchObject({ ok: true, status: 200, note: "Text Fragment" });
    });
  });
}

describe("checkLinkWithPlaywright()", () => {
  it("should return OK for hashes that exist (client-rendered)", async () => {
    const result = await checkLinkWithPlaywright("https://developer.apple.com/documentation/webkit#overview");
    expect(result).toEqual({ ok: true, status: 200 });
  });

  it("should return 'hash not found' for broken hash links (client-rendered)", { timeout: 10000 }, async () => {
    const result = await checkLinkWithPlaywright(
      "https://developer.apple.com/documentation/webkit#this-hash-does-not-exist"
    );
    expect(result).toEqual({ ok: false, status: 200, error: "hash not found" });
  });

  it(`should return OK for working L{number} hashes on GitHub `, async () => {
    const result = await checkLinkWithPlaywright(
      "https://github.com/fingerprintjs/fingerprintjs/blob/master/package.json#L3"
    );
    expect(result).toMatchObject({ ok: true, status: 200 });
  });

  it(`should return OK for working L{number}-L{number} hashes on GitHub `, async () => {
    const result = await checkLinkWithPlaywright(
      "https://github.com/fingerprintjs/fingerprintjs/blob/master/package.json#L3-L5"
    );
    expect(result).toMatchObject({ ok: true, status: 200 });
  });
});
