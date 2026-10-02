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
 * Check if a URL is a GitHub code line link like #L5 or #L5-L10
 * @param href - The URL to check
 * @returns - True if the URL is a GitHub code line link, false otherwise
 */
export const isGithubCodeLineLink = (href: string) => {
  const url = new URL(href);
  return (
    url.host === "github.com" &&
    url.pathname.includes("/blob/") &&
    /^#L\d+(-L\d+)?$/.test(decodeUrlHash(url.hash))
  );
};

/**
 * `URL.hash` stays percent-encoded (`#%4C12` for `#L12`), decode it (keeps the raw hash if it is malformed)
 */
export const decodeUrlHash = (hash: string): string => {
  try {
    return decodeURIComponent(hash);
  } catch {
    return hash;
  }
};

/**
 * Decodes a percent-encoded URL path segment (`%40fingerprint%2Fvue%402.0.0` -> `@fingerprint/vue@2.0.0`).
 * Octokit encodes request parameters itself, so they must be passed decoded (or they are encoded twice).
 * Keeps the raw segment if it is malformed (`100%` stays `100%`).
 */
export const decodePathSegment = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

/** Decoded, non-empty path segments of a GitHub URL (`/owner/repo/` -> `["owner", "repo"]`) */
export const getGithubPathSegments = (url: URL): string[] =>
  url.pathname.split("/").filter(Boolean).map(decodePathSegment);

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
