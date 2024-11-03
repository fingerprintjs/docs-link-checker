import { describe, it, expect, vi, assert } from "vitest";
import { checkLink } from "./link";
import { error } from "console";

describe("checkLink", () => {
  /**
   * Simple response checks
   */
  it("should return OK for working links", async () => {
    const result = await checkLink("https://www.google.com");
    expect(result).toEqual({ ok: true, status: 200 });
  });

  it("should return broken link for 404 links", async () => {
    const result = await checkLink("https://www.google.com/does/not/exist");
    expect(result).toEqual({ ok: false, error: "broken link", status: 404 });
  });

  it("should return broken link for malformed URLS", async () => {
    const result = await checkLink("ttps://www.google.com");
    assert(result.ok === false);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("broken link");
    expect(result.errorDetail).toBeTruthy();
  });

  /**
   * Hashes
   */
  it("should return OK for hashes that exist", async () => {
    const result = await checkLink("https://dev.fingerprint.com/docs/quick-start-guide#whats-next", true);
    expect(result).toEqual({ ok: true, status: 200 });
  });

  it("should return 'hash not found' for broken hash links", { timeout: 10000 }, async () => {
    const result = await checkLink("https://dev.fingerprint.com/#this-hash-does-not-exist", true);
    expect(result).toEqual({ ok: false, status: 200, error: "hash not found" });
  });

  it("should return OK for hashes implemented using 'href', like on GitHub", async () => {
    const result = await checkLink(
      "https://github.com/fingerprintjs/fingerprintjs?tab=readme-ov-file#getting-started",
      true
    );
    expect(result).toEqual({ ok: true, status: 200 });
  });

  it("should return OK for hashes implemented using 'href', like on GitHub, even despite different casing", async () => {
    const result = await checkLink(
      "https://github.com/fingerprintjs/fingerprintjs?tab=readme-ov-file#GeTTing-StArteD",
      true
    );
    expect(result).toEqual({ ok: true, status: 200 });
  });

  it("should return OK for working L{number} hashes on GitHub ", async () => {
    const result = await checkLink("https://github.com/fingerprintjs/fingerprintjs/blob/master/package.json#L3", true);
    expect(result).toEqual({ ok: true, status: 200 });
  });

  it("should return OK for working L{number}-L{number} hashes on GitHub ", async () => {
    const result = await checkLink(
      "https://github.com/fingerprintjs/fingerprintjs/blob/master/package.json#L3-L5",
      true
    );
    expect(result).toEqual({ ok: true, status: 200 });
  });

  it("should return 'hash not found' for broken L{number} hashes on GitHub ", async () => {
    const result = await checkLink(
      "https://github.com/fingerprintjs/fingerprintjs/blob/master/package.json#L99999",
      true
    );
    expect(result).toEqual({ ok: false, status: 200, error: "hash not found" });
  });

  it("should return 'hash not found' for broken L{number}-L{number} hashes on GitHub ", async () => {
    const result = await checkLink(
      "https://github.com/fingerprintjs/fingerprintjs/blob/master/package.json#L8888-L9999",
      true
    );
    expect(result).toEqual({ ok: false, status: 200, error: "hash not found" });
  });

  /**
   * Text fragments
   */
  it("should return OK for links with text fragment", async () => {
    const result = await checkLink("https://developer.mozilla.org/en-US/docs/Web/HTML/Element/a#:~:text=human");
    expect(result).toEqual({ ok: true, status: 200, note: "Text Fragment" });
  });

  // Skipping this edge case for
  it("should return OK for links with text fragment, even if its not there", async () => {
    const result = await checkLink(
      "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/a#:~:text=IS_NOT_THERE_DKSOAPD"
    );
    expect(result).toEqual({ ok: true, status: 200, note: "Text Fragment" });
  });
});
