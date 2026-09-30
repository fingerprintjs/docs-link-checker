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
    url.host === "github.com" && url.pathname.includes("/blob/") && /^#L\d+(-L\d+)?$/.test(url.hash)
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
