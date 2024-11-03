import { describe, it, expect } from "vitest";
import { extractLinksFromMarkdown } from "./markdown";

describe("extractLinksFromMarkdown", () => {
  // Test basic markdown link extraction
  it("should extract simple markdown links", async () => {
    const markdown = "[Google](https://www.google.com) is a search engine.";
    const page = "test-page";

    const links = await extractLinksFromMarkdown(markdown, page);

    expect(links).toEqual([
      {
        page: "test-page",
        href: "https://www.google.com",
        text: "Google",
      },
    ]);
  });

  // Test multiple links in a single markdown string
  it("should extract multiple markdown links", async () => {
    const markdown = "[Google](https://www.google.com) and [GitHub](https://github.com) are websites.";
    const page = "multi-link-page";

    const links = await extractLinksFromMarkdown(markdown, page);

    expect(links).toEqual([
      {
        page: "multi-link-page",
        href: "https://www.google.com",
        text: "Google",
      },
      {
        page: "multi-link-page",
        href: "https://github.com",
        text: "GitHub",
      },
    ]);
  });

  // Test links with special characters in text or URL
  it("should handle links with special characters", async () => {
    const markdown =
      "[Search! Engine](https://www.google.com/search?q=test) with [special chars](https://example.com/path/to/page?param=value#section).";
    const page = "special-chars-page";

    const links = await extractLinksFromMarkdown(markdown, page);

    expect(links).toEqual([
      {
        page: "special-chars-page",
        href: "https://www.google.com/search?q=test",
        text: "Search! Engine",
      },
      {
        page: "special-chars-page",
        href: "https://example.com/path/to/page?param=value#section",
        text: "special chars",
      },
    ]);
  });

  // Test markdown links within other text elements
  it("should extract links from mixed markdown content", async () => {
    const markdown =
      "# Title\n\nThis is a paragraph with [a link](https://example.com).\n\n## Subheading\n\nAnother [link here](https://another.com).";
    const page = "mixed-content-page";

    const links = await extractLinksFromMarkdown(markdown, page);

    expect(links).toEqual([
      {
        page: "mixed-content-page",
        href: "https://example.com",
        text: "a link",
      },
      {
        page: "mixed-content-page",
        href: "https://another.com",
        text: "link here",
      },
    ]);
  });

  // Test markdown links with nested formatting
  it("should handle links with nested formatting", async () => {
    const markdown = "[**Bold Link**](https://bold.com) and [*Italic Link*](https://italic.com)";
    const page = "nested-formatting-page";

    const links = await extractLinksFromMarkdown(markdown, page);

    expect(links).toEqual([
      {
        page: "nested-formatting-page",
        href: "https://bold.com",
        text: "Bold Link",
      },
      {
        page: "nested-formatting-page",
        href: "https://italic.com",
        text: "Italic Link",
      },
    ]);
  });

  // Test edge cases
  it("should return empty array for markdown without links", async () => {
    const markdown = "This is a plain text without any links.";
    const page = "no-links-page";

    const links = await extractLinksFromMarkdown(markdown, page);

    expect(links).toEqual([]);
  });

  // Test reference-style links
  it("should handle reference-style markdown links", async () => {
    const markdown = "[Reference Link][ref]\n\n[ref]: https://reference.com";
    const page = "reference-links-page";

    const links = await extractLinksFromMarkdown(markdown, page);

    expect(links).toEqual([
      {
        page: "reference-links-page",
        href: "https://reference.com",
        text: "Reference Link",
      },
    ]);
  });

  // Test relative path links
  it("should handle relative path links by prepending base URL", async () => {
    const markdown = "[Relative Link](/path/to/file.ts) and [Another Relative](/another/link.md)";
    const page = "https://example.com/current/page";

    const links = await extractLinksFromMarkdown(markdown, page);

    expect(links).toEqual([
      {
        page: "https://example.com/current/page",
        href: "https://example.com/path/to/file.ts",
        text: "Relative Link",
      },
      {
        page: "https://example.com/current/page",
        href: "https://example.com/another/link.md",
        text: "Another Relative",
      },
    ]);
  });

  // Test root-relative path links
  it("should handle root-relative path links by prepending base domain", async () => {
    const markdown = "[Root Relative](/index.html) and [Another Root Relative](/docs/guide.md)";
    const page = "https://example.com/current/page";

    const links = await extractLinksFromMarkdown(markdown, page);

    expect(links).toEqual([
      {
        page: "https://example.com/current/page",
        href: "https://example.com/index.html",
        text: "Root Relative",
      },
      {
        page: "https://example.com/current/page",
        href: "https://example.com/docs/guide.md",
        text: "Another Root Relative",
      },
    ]);
  });

  // Test anchor links
  it("should handle anchor links by prepending current page URL", async () => {
    const markdown = "[Anchor Link](#section1) and [Another Anchor](#another-section)";
    const page = "https://example.com/current/page";

    const links = await extractLinksFromMarkdown(markdown, page);

    expect(links).toEqual([
      {
        page: "https://example.com/current/page",
        href: "https://example.com/current/page#section1",
        text: "Anchor Link",
      },
      {
        page: "https://example.com/current/page",
        href: "https://example.com/current/page#another-section",
        text: "Another Anchor",
      },
    ]);
  });

  // Test mixed link types
  it("should handle a mix of absolute, relative, and anchor links", async () => {
    const markdown =
      "[Absolute Link](https://other.com) [Relative Link](/path) [Anchor](#section) [Full URL](https://example.com/page)";
    const page = "https://example.com/current/page";

    const links = await extractLinksFromMarkdown(markdown, page);

    expect(links).toEqual([
      {
        page: "https://example.com/current/page",
        href: "https://other.com",
        text: "Absolute Link",
      },
      {
        page: "https://example.com/current/page",
        href: "https://example.com/path",
        text: "Relative Link",
      },
      {
        page: "https://example.com/current/page",
        href: "https://example.com/current/page#section",
        text: "Anchor",
      },
      {
        page: "https://example.com/current/page",
        href: "https://example.com/page",
        text: "Full URL",
      },
    ]);
  });

  // Test link resolution with different page URL formats
  it("should handle page URLs with and without trailing slashes", async () => {
    const markdown = "[Relative Link](/test.md)";

    // Test with page URL ending with slash
    const pageWithSlash = "https://example.com/current/";
    const linksWithSlash = await extractLinksFromMarkdown(markdown, pageWithSlash);
    expect(linksWithSlash).toEqual([
      {
        page: "https://example.com/current/",
        href: "https://example.com/test.md",
        text: "Relative Link",
      },
    ]);

    // Test with page URL without trailing slash
    const pageWithoutSlash = "https://example.com/current";
    const linksWithoutSlash = await extractLinksFromMarkdown(markdown, pageWithoutSlash);
    expect(linksWithoutSlash).toEqual([
      {
        page: "https://example.com/current",
        href: "https://example.com/test.md",
        text: "Relative Link",
      },
    ]);
  });

  // Test links in nested GitHub readmes to GitHub paths in the same repository
  it("should handle anchor links by prepending current page URL", async () => {
    const markdown = "See [Folder](/nested/folder) and [File](/nested/file.md)";
    const page = "https://github.com/fingerprintjs/repository/blob/main/folder/README.md";

    const links = await extractLinksFromMarkdown(markdown, page);

    expect(links).toEqual([
      {
        page: "https://github.com/fingerprintjs/repository/blob/main/folder/README.md",
        href: "https://github.com/fingerprintjs/repository/blob/main/nested/folder",
        text: "Folder",
      },
      {
        page: "https://github.com/fingerprintjs/repository/blob/main/folder/README.md",
        href: "https://github.com/fingerprintjs/repository/blob/main/nested/file.md",
        text: "File",
      },
    ]);
  });
});
