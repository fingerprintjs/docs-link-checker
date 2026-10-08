import { describe, expect, it } from "vitest";
import { filterOutIrrelevantLinks } from "./page";

const link = (href: string) => ({ href, text: "text", page: "https://example.com/page" });

describe("filterOutIrrelevantLinks()", () => {
  it("keeps http(s) links and unparsable URLs (reported as broken later)", () => {
    const links = [link("https://example.com/a"), link("http://example.com/b"), link("not a url")];
    expect(filterOutIrrelevantLinks(links)).toEqual(links);
  });

  it("skips links with non-http(s) schemes", () => {
    const links = [
      "tel:+123",
      "javascript:void(0)",
      "data:text/plain,hi",
      "mailto:a@b.com",
      "ftp://example.com/f",
    ];
    expect(filterOutIrrelevantLinks(links.map(link))).toEqual([]);
  });

  it.each([
    "http://localhost:3000/docs",
    "https://apps.apple.com/app/id123",
    "https://console.aws.amazon.com/iam",
    "https://eu-west-1.console.aws.amazon.com/ec2",
    "https://portal.azure.com/#home",
    "https://example.com/cdn-cgi/l/email-protection#1e6d",
    "https://dash.cloudflare.com/login",
    "doc:some-page",
    "ref:some-page",
    "https://dev.fingerprint.com/recipes/some-recipe",
    "https://dev.fingerprint.com/discuss/some-thread",
  ])("skips the known unreachable or login-only link %s", (href) => {
    expect(filterOutIrrelevantLinks([link(href)])).toEqual([]);
  });

  // Hosts are matched exactly, a similar URL on another host or path must still be checked
  it.each([
    "https://example.com/localhost",
    "https://example.com/apps.apple.com",
    "https://example.com/portal.azure.com",
    "https://example.com/dash.cloudflare.com",
    "https://portal.azure.com.example.com/",
    "https://dash.cloudflare.com.example.com/",
    "https://dev.fingerprint.com/reference/get-event",
    "https://dev.fingerprint.com/docs/recipes",
    "https://example.com/doc:page",
    "https://example.com/ref:page",
    "https://example.com/cdn-cgi/l/other",
  ])("keeps the similar but relevant link %s", (href) => {
    const links = [link(href)];
    expect(filterOutIrrelevantLinks(links)).toEqual(links);
  });
});

// TODO(STEP 2, PIPELINE group): port these tests
describe("getLinksFromPages()", () => {
  it.todo(
    "reports a page that still fails after the retries as an extraction error (not silently empty)",
  );
});
