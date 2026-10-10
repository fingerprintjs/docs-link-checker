import { parseLineAnchor } from "../check/line_anchor";

/**
 * Check if a URL is a GitHub URL
 * @param url - The URL to check
 * @returns - True if the URL is a GitHub URL, false otherwise
 */
export const isGithubUrl = (url: string) => {
  const githubUrl = new URL(url);
  return githubUrl.hostname === "github.com";
};

/**
 * Check if a URL is a GitHub code line link like #L5, #L5-L10 or #L5C3-L10C1 (the grammar of `parseLineAnchor`)
 * @param href - The URL to check
 * @returns - True if the URL is a GitHub code line link, false otherwise
 */
export const isGithubCodeLineLink = (href: string) => {
  const url = new URL(href);
  return (
    url.hostname === "github.com" &&
    url.pathname.includes("/blob/") &&
    parseLineAnchor(safeDecode(url.hash).replace(/^#/, "")) !== undefined
  );
};

/**
 * `decodeURIComponent`, keeping the input unchanged if it is not valid percent-encoding (a URL hash or path
 * segment with a stray `%` that isn't an escape sequence, like `100%`).
 */
export const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** Decoded, non-empty path segments of a GitHub URL (`/owner/repo/` -> `["owner", "repo"]`) */
export const getGithubPathSegments = (url: URL): string[] =>
  url.pathname.split("/").filter(Boolean).map(safeDecode);

/**
 * Top-level github.com routes that are GitHub's own pages, not users or organizations (GitHub reserves these names).
 * Not exhaustive: an account URL that the API doesn't know is also checked as a page (see `checkLinkWithGithubApi`).
 */
const GITHUB_RESERVED_ROUTES = new Set([
  "about",
  "account",
  "apps",
  "codespaces",
  "collections",
  "contact",
  "copilot",
  "customer-stories",
  "dashboard",
  "enterprise",
  "events",
  "explore",
  "features",
  "issues",
  "join",
  "login",
  "logout",
  "marketplace",
  "new",
  "notifications",
  "organizations",
  "orgs",
  "pricing",
  "pulls",
  "readme",
  "resources",
  "search",
  "security",
  "sessions",
  "settings",
  "signup",
  "site",
  "solutions",
  "sponsors",
  "stars",
  "team",
  "topics",
  "trending",
]);

/**
 * Check if a URL points to one of GitHub's own pages (`/features`, `/topics/javascript`, `/marketplace/actions/x`...)
 * rather than to an account or a repository. These are checked as regular pages, not with the API.
 */
export const isGithubReservedRoute = (href: string) => {
  const url = new URL(href);
  const [first] = getGithubPathSegments(url);
  return (
    url.hostname === "github.com" &&
    first !== undefined &&
    GITHUB_RESERVED_ROUTES.has(first.toLowerCase())
  );
};

/**
 * Check if a URL is a GitHub wiki link like https://github.com/owner/repo/wiki/Page
 * (wikis are not available through the API, they are checked with fetch)
 */
export const isGithubWikiLink = (href: string) => {
  const url = new URL(href);
  const [, , section] = url.pathname.split("/").filter(Boolean);
  return url.hostname === "github.com" && section === "wiki";
};
