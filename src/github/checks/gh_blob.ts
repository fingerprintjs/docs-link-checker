import { LinkCheckResult } from "../../types";
import { getMyOctokit } from "../github_client";
import GithubSlugger from "github-slugger";
import * as cheerio from "cheerio";
import { marked, Parser, Token } from "marked";
import { tryCatch } from "../../utils/tryCatch";
import { RequestError } from "@octokit/types";
import { decodeHash } from "../../hash";

// GitHub prefixes ids in rendered markdown with `user-content-`, links work both with and without it
const USER_CONTENT_PREFIX = "user-content-";

/**
 * Collects anchor ids from HTML: `id` on any element and `name` on `<a>` elements.
 */
const getHtmlAnchors = (html: string): string[] => {
  const $ = cheerio.load(html, null, false);
  const anchors: string[] = [];
  $("[id]").each((_, element) => {
    anchors.push($(element).attr("id")!);
  });
  $("a[name]").each((_, element) => {
    anchors.push($(element).attr("name")!);
  });
  return anchors;
};

/**
 * Returns all anchors GitHub generates for a markdown file (lowercase):
 * - Heading slugs (GitHub-slugger semantics, duplicate headings get `-1`, `-2`... suffixes).
 *   Headings in fenced code blocks are ignored, headings in blockquotes and lists are included.
 * - Explicit HTML anchors like `<a name="x">`, `<a id="x">` and `<h2 id="x">`.
 */
export const getMarkdownAnchors = (markdown: string): Set<string> => {
  const slugger = new GithubSlugger();
  const anchors = new Set<string>();

  marked.walkTokens(marked.lexer(markdown), (token: Token) => {
    if (token.type === "heading") {
      // Slug is based on the rendered text content of the heading (no markdown syntax, link URLs or HTML tags)
      const headingHtml = Parser.parseInline(token.tokens ?? []);
      const headingText = cheerio.load(headingHtml, null, false).text().trim();
      anchors.add(slugger.slug(headingText));
    }
    if (token.type === "html") {
      getHtmlAnchors(token.raw).forEach((anchor) => anchors.add(anchor.toLowerCase()));
    }
  });

  return anchors;
};

/**
 * Check if a GitHub blob exists
 * @param fullUrl - The full URL of the blob
 * @param owner - The owner of the repository
 * @param repo - The repository name
 * @param pathParts - The path parts of the URL
 * @returns - A LinkCheckResult object
 */
export const checkGitHubBlobLink = async (
  fullUrl: URL,
  owner: string,
  repo: string,
  pathParts: string[]
): Promise<LinkCheckResult> => {
  const octokit = getMyOctokit();
  const [, branch, ...restOfPath] = pathParts;
  const path = restOfPath.join("/");
  // Remove the # character, decode percent-encoding and make it lowercase
  const hash = decodeHash(fullUrl.hash).toLowerCase();

  const { data: response, error } = await tryCatch(
    octokit.repos.getContent({
      owner,
      repo,
      ref: branch,
      path,
    })
  );

  if (error) {
    if ((error as unknown as RequestError).status === 404) {
      return {
        ok: false,
        error: "broken link",
        status: 404,
        errorDetail: "File not found in repository",
      };
    }
    return {
      ok: false,
      error: "unexpected error",
      errorDetail: String(error),
    };
  }

  // If there's no hash, we're done - the file exists
  if (!hash) {
    return { ok: true, status: 200 };
  }

  // For hash checking, we need to get the file content
  const fileData = response.data;
  if (!("content" in fileData)) {
    return {
      ok: false,
      error: "hash not found",
      status: 200,
      errorDetail: "File has no content",
    };
  }

  const content = Buffer.from(fileData.content as string, "base64").toString();
  const anchors = getMarkdownAnchors(content);

  const hashWithoutPrefix = hash.startsWith(USER_CONTENT_PREFIX)
    ? hash.slice(USER_CONTENT_PREFIX.length)
    : hash;
  if (anchors.has(hash) || anchors.has(hashWithoutPrefix)) {
    return { ok: true, status: 200 };
  }

  return {
    ok: false,
    error: "hash not found",
    status: 200,
    errorDetail: `No heading found matching hash: ${hash}`,
  };
};
