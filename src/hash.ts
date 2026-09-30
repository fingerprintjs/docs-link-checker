import * as cheerio from "cheerio";
import { decodeUrlHash, isGithubCodeLineLink } from "./github/gh_url";

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
  isGithubCodeLineLink(url)
    ? decodeUrlHash(hash).replace(/^#/, "").split("-")[0].slice(1)
    : undefined;

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
 * All the values in a (server-rendered) page a hash can point to. Built once per page, so many hashes
 * pointing to the same page can be checked without parsing the HTML again.
 */
export type AnchorIndex = {
  /** `id` attributes of any element */
  ids: Set<string>;
  /** `name` attributes of `<a>` elements */
  names: Set<string>;
  /** `href` attributes */
  hrefs: Set<string>;
  /** `data-line-number` attributes (GitHub code views) */
  lineNumbers: Set<string>;
};

export const buildAnchorIndex = (html: string): AnchorIndex => {
  const index: AnchorIndex = {
    ids: new Set(),
    names: new Set(),
    hrefs: new Set(),
    lineNumbers: new Set(),
  };
  const $ = cheerio.load(html);
  $("[id], a[name], [href], [data-line-number]").each((_, element) => {
    const { id, name, href } = element.attribs;
    const lineNumber = element.attribs["data-line-number"];
    if (id !== undefined) index.ids.add(id);
    if (name !== undefined && element.tagName === "a") index.names.add(name);
    if (href !== undefined) index.hrefs.add(href);
    if (lineNumber !== undefined) index.lineNumbers.add(lineNumber);
  });
  return index;
};

/**
 * Checks if the hash points to an element in the anchor index of a page.
 * Compares attribute values directly instead of building selectors, so no hash value can break the check.
 * @param index - anchor index of the page, see `buildAnchorIndex`
 * @param hash - the hash, with or without the leading `#`
 * @param url - the full URL (used to detect GitHub code line links)
 */
export const isHashInAnchorIndex = (index: AnchorIndex, hash: string, url: string): boolean => {
  const variants = getHashVariants(hash);
  if (variants.some((variant) => index.ids.has(variant) || index.names.has(variant))) {
    return true;
  }
  if (
    variants.some(
      (variant) => index.hrefs.has(`#${variant}`) || index.hrefs.has(`#${variant.toLowerCase()}`),
    )
  ) {
    return true;
  }
  const lineNumber = getGithubLineNumber(hash, url);
  return lineNumber !== undefined && index.lineNumbers.has(lineNumber);
};

/**
 * Checks if the hash points to an element in the (server-rendered) HTML.
 * @param html - page HTML
 * @param hash - the hash, with or without the leading `#`
 * @param url - the full URL (used to detect GitHub code line links)
 */
export const isHashPresentInHtml = (html: string, hash: string, url: string): boolean =>
  isHashInAnchorIndex(buildAnchorIndex(html), hash, url);
