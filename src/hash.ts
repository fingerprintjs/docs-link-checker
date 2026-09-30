import * as cheerio from "cheerio";
import { isGithubCodeLineLink } from "./github/gh_url";

/**
 * Removes the leading `#` and decodes percent-encoding (`#caf%C3%A9` -> `café`).
 * Returns the hash as-is if it is not valid percent-encoding.
 */
export const decodeHash = (hash: string): string => {
  const withoutHash = hash.startsWith("#") ? hash.slice(1) : hash;
  try {
    return decodeURIComponent(withoutHash);
  } catch {
    return withoutHash;
  }
};

/**
 * Serializes a value as a quoted CSS string (for attribute selectors like `[id="..."]`),
 * escaping characters that would break the selector. Similar to `CSS.escape`, but for string values.
 */
export const cssString = (value: string): string =>
  `"${value
    .replace(/\0/g, "�")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    // Every other non-printable character (U+0001-U+001F, U+007F) as a hex escape, like `\a ` for a newline
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
    .replace(/[\u0001-\u001f\u007f]/g, (char) => `\\${char.charCodeAt(0).toString(16)} `)}"`;

/**
 * All the forms of the hash (without `#`) an anchor could use: the raw (possibly percent-encoded) form and the decoded form.
 */
const getHashVariants = (rawHash: string): string[] => {
  const raw = rawHash.startsWith("#") ? rawHash.slice(1) : rawHash;
  return [...new Set([raw, decodeHash(raw)])];
};

/**
 * GitHub uses `data-line-number` attribute to handle line links like `#L12` and `#L12-L15` (check just the first one for simplicity)
 */
const getGithubLineNumber = (hash: string, url: string): string | undefined =>
  isGithubCodeLineLink(url) ? hash.replace(/^#/, "").split("-")[0].slice(1) : undefined;

/**
 * CSS selectors matching elements the hash can point to (all values properly escaped).
 * @param hash - the hash, with or without the leading `#`
 * @param url - the full URL (used to detect GitHub code line links)
 */
export const getHashSelectors = (hash: string, url: string): string[] => {
  const selectors: string[] = [];
  for (const variant of getHashVariants(hash)) {
    selectors.push(`[id=${cssString(variant)}]`);
    selectors.push(`a[name=${cssString(variant)}]`);
    // Some websites put the hash into the `href="#hash"` attribute instead of `id="hash"`
    selectors.push(`[href=${cssString(`#${variant}`)}]`);
    selectors.push(`[href=${cssString(`#${variant.toLowerCase()}`)}]`);
  }
  const lineNumber = getGithubLineNumber(hash, url);
  if (lineNumber) {
    selectors.push(`[data-line-number=${cssString(lineNumber)}]`);
  }
  return [...new Set(selectors)];
};

/**
 * Checks if the hash points to an element in the (server-rendered) HTML.
 * Compares attributes directly instead of building selectors, so no hash value can break the check.
 * @param html - page HTML
 * @param hash - the hash, with or without the leading `#`
 * @param url - the full URL (used to detect GitHub code line links)
 */
export const isHashPresentInHtml = (html: string, hash: string, url: string): boolean => {
  const variants = getHashVariants(hash);
  const ids = new Set(variants);
  const hrefs = new Set(variants.flatMap((variant) => [`#${variant}`, `#${variant.toLowerCase()}`]));
  const lineNumber = getGithubLineNumber(hash, url);

  const $ = cheerio.load(html);
  let found = false;
  $("[id], a[name], [href], [data-line-number]").each((_, element) => {
    const { id, name, href } = element.attribs;
    if (
      (id !== undefined && ids.has(id)) ||
      (name !== undefined && element.tagName === "a" && ids.has(name)) ||
      (href !== undefined && hrefs.has(href)) ||
      (lineNumber !== undefined && element.attribs["data-line-number"] === lineNumber)
    ) {
      found = true;
      return false; // stop iterating
    }
    return undefined;
  });
  return found;
};
