import { marked } from "marked";

export type Link = {
  page: string;
  href: string;
  text: string;
};

function extractLinkPlainText(input: string): string {
  return input
    .replace(/\*\*|__/g, "") // Remove bold markers
    .replace(/\*|_/g, "") // Remove italic markers
    .replace(/~~|`/g, ""); // Remove strikethrough and code markers
}

const extractGitHubRepoUrl = (url) => {
  // Matches GitHub URL with optional branch after /blob/
  const match = url.match(/(https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/[^/]+)/);
  return match ? match[1] : null;
};

// Helper function to resolve relative URLs
function resolveUrl(base: string, relative: string): string {
  // If it's already an absolute URL, return as-is
  try {
    const url = new URL(relative);
    return relative;
  } catch {
    // Not an absolute URL, so resolve it
    const baseUrl = new URL(base);
    const resolvedUrl = new URL(relative, baseUrl);
    return resolvedUrl.toString();
  }
}

export function extractLinksFromMarkdown(markdown: string, page: string): Link[] {
  const links: Link[] = [];

  // Create a custom renderer for marked
  const renderer = new marked.Renderer();

  // Override the link method to capture links
  renderer.link = (link) => {
    const href = link.href;
    const text = extractLinkPlainText(link.text);
    // const text = link.text;

    // Resolve relative and anchor links
    let resolvedHref = href;

    // Check if the link is a relative link to a file/folder in a GitHub repo
    const repoUrl = extractGitHubRepoUrl(page);
    if (repoUrl && href.startsWith("/")) {
      // It's a GitHub repo link, so resolve it
      resolvedHref = `${repoUrl}${href}`;
    }
    // Check if it's a normal relative or anchor link
    else if (href.startsWith("/")) {
      // Root-relative path: combine with base origin
      resolvedHref = resolveUrl(page, href);
    } else if (href.startsWith("#")) {
      // Anchor link: prepend current page URL
      resolvedHref = `${page}${href}`;
    } else if (!href.startsWith("http://") && !href.startsWith("https://")) {
      // Relative path: resolve against page URL
      resolvedHref = resolveUrl(page, href);
    }

    // Store the link
    links.push({
      page,
      href: resolvedHref,
      text: text,
    });

    // Return empty string to prevent rendering in HTML
    return "";
  };

  // Parse the markdown with our custom renderer
  marked.parse(markdown, { renderer });

  return links;
}
