import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getContent } = vi.hoisted(() => ({ getContent: vi.fn() }));

vi.mock("../github_client", () => ({
  getMyOctokit: () => ({ repos: { getContent } }),
}));

import { checkGitHubBlobLink, getMarkdownAnchors } from "./gh_blob";

const readme = readFileSync(join(import.meta.dirname, "..", "..", "__fixtures__", "readme.md"), "utf8");

const checkHash = (hash: string) => {
  const url = new URL(`https://github.com/owner/repo/blob/main/README.md${hash}`);
  return checkGitHubBlobLink(url, "owner", "repo", ["blob", "main", "README.md"]);
};

beforeEach(() => {
  getContent.mockReset();
  getContent.mockResolvedValue({
    data: { type: "file", content: Buffer.from(readme).toString("base64") },
  });
});

describe("getMarkdownAnchors()", () => {
  const anchors = getMarkdownAnchors(readme);

  it("includes heading slugs", () => {
    expect(anchors).toContain("getting-started");
    expect(anchors).toContain("installation");
    expect(anchors).toContain("setext-heading");
    expect(anchors).toContain("a--b");
  });

  it("slugs the rendered heading text (no markdown syntax or link URLs)", () => {
    expect(anchors).toContain("usage-with-code-and-bold-and-a-link");
  });

  it("adds -1, -2 suffixes to duplicate headings", () => {
    expect(anchors).toContain("usage");
    expect(anchors).toContain("usage-1");
    expect(anchors).not.toContain("usage-2");
  });

  it("includes headings in blockquotes and lists", () => {
    expect(anchors).toContain("heading-in-a-quote");
    expect(anchors).toContain("heading-in-a-list");
  });

  it("ignores # lines inside fenced code blocks", () => {
    expect(anchors).not.toContain("not-a-heading");
    expect(anchors).not.toContain("also-not-a-heading");
  });

  it("includes explicit HTML anchors", () => {
    expect(anchors).toContain("custom-anchor"); // <a name="...">
    expect(anchors).toContain("inline-anchor"); // <a id="...">
    expect(anchors).toContain("project-logo"); // <h1 id="...">
  });
});

describe("checkGitHubBlobLink() (mocked GitHub API)", () => {
  it.each(["", "#installation", "#usage-1", "#custom-anchor", "#InStAlLaTiOn", "#user-content-installation"])(
    "returns OK for %s",
    async (hash) => {
      expect(await checkHash(hash)).toEqual({ ok: true, status: 200 });
    }
  );

  it("returns 'hash not found' for code block comments", async () => {
    expect(await checkHash("#not-a-heading")).toEqual({
      ok: false,
      error: "hash not found",
      status: 200,
      errorDetail: "No heading found matching hash: not-a-heading",
    });
  });

  it("decodes percent-encoded hashes", async () => {
    getContent.mockResolvedValue({
      data: { type: "file", content: Buffer.from("## Café\n").toString("base64") },
    });
    expect(await checkHash("#caf%C3%A9")).toEqual({ ok: true, status: 200 });
  });

  it("returns broken link when the API returns 404", async () => {
    getContent.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
    expect(await checkHash("")).toMatchObject({ ok: false, error: "broken link", status: 404 });
  });
});
