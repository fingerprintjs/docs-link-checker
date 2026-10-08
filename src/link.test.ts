// Skeleton for most of it: the titles of main's tests, to port with the new design (STEP 2, PIPELINE and BROWSER groups).
import { describe, expect, it } from "vitest";
import { interleaveByHost } from "./link";

describe("checkLinks() deduplication", () => {
  it.todo("checks each href only once, even when concurrent tasks check the same href");
  it.todo("checks each GitHub href only once with the GitHub API");
});
describe("checkLinks() Playwright escalation", () => {
  it.todo("GitHub API result: %s -> re-checked with Playwright: %s");
  it.todo("checks GitHub code line links with the GitHub API, without the browser");
  it.todo(
    "falls back to the browser for GitHub code line links the API can't check (no token, rate limited)",
  );
  it.todo("reports unparsable URLs as broken without any request or Playwright re-check");
  it.todo("never fetches or re-checks non-http(s) URLs like %s");
  it.todo("fetch result: %s -> re-checked with Playwright: %s");
  it.todo("re-checks 'hash not found' from fetch with Playwright (client-side rendered page)");
  it.todo("checks GitHub wiki links with fetch");
  it.todo(
    "checks GitHub's own pages with fetch (re-checked with Playwright if blocked), not as accounts",
  );
});
describe("checkLinkWithFetch()", () => {
  it.todo("reports a request that never answers as broken link after the timeout");
  it.todo("reports a failed request, also for a link without a hash");
  it.todo("accepts a page that answers HEAD with 404 and GET with 200");
  it.todo("reports a 429 with Retry-After that persists after the retries as unexpected error");
  it.todo("accepts Google Help accordion fragments without an element id");
  it.todo("finds hash %s in server-rendered HTML");
  it.todo("reports missing hashes as 'hash not found' (not 'broken link')");
});
describe("checkUrlsOnPageWithPlaywright() hash check", () => {
  it.todo("finds a hash with special characters");
  it.todo("reports missing hashes as 'hash not found'");
  it.todo("accepts Google Help accordion fragments without waiting for an element");
  it.todo("waits longer for an anchor rendered late (same navigation)");
  it.todo("waits for a missing anchor until the 15s budget is used up");
  it.todo("reports an anchor rendered after the budget as missing");
  it.todo("reports a %s page with its body");
  it.todo("does not wait forever for the body of a forbidden page");
  describe("GitHub code line links", () => {
    it.todo("finds line %s in the code view");
    it.todo("reports line %s beyond the end of the file without the long wait");
    it.todo("reports a line as not found when the code view never renders");
  });
});
describe("checkLinks() grouping by page (URL without hash)", () => {
  it.todo("fetches a page once for all its hashes and checks every hash against the same HTML");
  it.todo("reports a broken page for every hash pointing to it (one request)");
  it.todo(
    "navigates once with Playwright for all hashes of a page and checks each hash in the same DOM",
  );
  it.todo("checks GitHub code line links to the same file with one navigation (browser fallback)");
  it.todo("navigates once per page with Playwright, also for repeated hrefs");
});
describe("checkLinks() Playwright hashes of one page", () => {
  it.todo("finds late anchors of every hash with one navigation and one shared wait");
  it.todo("finds a hash that is rendered only after the hash is set in the open page (SPA tabs)");
  it.todo("keeps 'hash not found' for a hash whose in-page retry fails, other results stay");
  it.todo("stops the in-page retries of a page that hangs, other results stay");
  it.todo("spends the 15s budget once per page, not once per missing hash");
});
describe("server errors (502, 503, 504)", () => {
  it.todo("fetch: reports a 503 that persists after the retries as 'could not check', not broken");
  it.todo("fetch: checks the hash of a page that answers 503 first");
  it.todo("Playwright: retries the navigation after a 503 and checks the code line");
  it.todo("Playwright: respects Retry-After of a 503 navigation");
  it.todo("Playwright: gives up right away when Retry-After is longer than the maximum delay");
  it.todo("checkLinks(): a fetch 503 persisting in the browser too is 'could not check'");
  it.todo(
    "Playwright: waits for a host pause (e.g. set by a fetch server error) before navigating",
  );
  it.todo(
    "Playwright: after a redirect to another host, a 503 pauses the final URL's host and the retry waits for it",
  );
});
describe("checkLinks() per-host limit", () => {
  it.todo("never sends more than the per-host limit of concurrent requests to a host");
});
describe("checkLinks() metrics", () => {
  it.todo("counts total links, unique URLs, unique pages and page fetches");
  it.todo("counts every HTTP request (redirect hops) separately from unique pages");
});
describe("interleaveByHost()", () => {
  it("orders items round-robin by host, keeping the order within a host", () => {
    const hrefs = [
      "https://a.com/1",
      "https://a.com/2",
      "https://a.com/3",
      "https://b.com/1",
      "https://c.com/1",
    ];
    expect(interleaveByHost(hrefs.map((href) => ({ href }))).map((item) => item.href)).toEqual([
      "https://a.com/1",
      "https://b.com/1",
      "https://c.com/1",
      "https://a.com/2",
      "https://a.com/3",
    ]);
  });

  it("keeps the round-robin order when hosts run out at different times", () => {
    const hrefs = [
      "https://a.com/1",
      "https://b.com/1",
      "https://a.com/2",
      "https://c.com/1",
      "https://a.com/3",
      "https://c.com/2",
      "https://a.com/4",
    ];
    expect(interleaveByHost(hrefs.map((href) => ({ href }))).map((item) => item.href)).toEqual([
      "https://a.com/1",
      "https://b.com/1",
      "https://c.com/1",
      "https://a.com/2",
      "https://c.com/2",
      "https://a.com/3",
      "https://a.com/4",
    ]);
  });

  it("visits every item once (many single-link hosts and one big host)", () => {
    // Must be linear in the number of items: scanning exhausted hosts in every round would be 1e9 steps here
    // and does not finish within the test timeout
    const items = [
      ...Array.from({ length: 100_000 }, (_, i) => ({ href: `https://big.example.com/${i}` })),
      ...Array.from({ length: 10_000 }, (_, i) => ({ href: `https://host-${i}.example.com/` })),
    ];

    const result = interleaveByHost(items);

    expect(result).toHaveLength(items.length);
    expect(new Set(result).size).toBe(items.length);
    // First round: one item of every host, then only the big host is left
    expect(result[0]!.href).toBe("https://big.example.com/0");
    expect(result[1]!.href).toBe("https://host-0.example.com/");
    expect(result[10_001]!.href).toBe("https://big.example.com/1");
    expect(result.at(-1)!.href).toBe("https://big.example.com/99999");
  });
});
