import * as cheerio from "cheerio";
import { isGithubCodeLineLink, safeDecode } from "./github/gh_url";
import { parseLineAnchor } from "./line_anchor";

/**
 * Removes the leading `#` and decodes percent-encoding (`#caf%C3%A9` -> `café`).
 * Returns the hash as-is if it is not valid percent-encoding.
 */
export const decodeHash = (hash: string): string =>
  safeDecode(hash.startsWith("#") ? hash.slice(1) : hash);

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
    // oxlint-disable-next-line no-control-regex -- matching control characters is the point
    .replace(/[\u0001-\u001f\u007f]/g, (char) => `\\${char.charCodeAt(0).toString(16)} `)}"`;

/**
 * All the forms of the hash (without `#`) an anchor could use: the raw (possibly percent-encoded) form and the decoded form.
 */
const getHashVariants = (rawHash: string): string[] => {
  const raw = rawHash.startsWith("#") ? rawHash.slice(1) : rawHash;
  return [...new Set([raw, decodeHash(raw)])];
};

/**
 * GitHub uses `data-line-number` attribute to handle line links like `#L12`, `#L12-L15` and `#L12C3-L15C1` (check just
 * the first line for simplicity)
 */
const getGithubLineNumber = (hash: string, url: string): string | undefined => {
  if (!isGithubCodeLineLink(url)) {
    return undefined;
  }
  const lines = parseLineAnchor(safeDecode(hash).replace(/^#/, ""));
  return lines ? String(lines.firstLine) : undefined;
};

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
};

export const buildAnchorIndex = (html: string): AnchorIndex => {
  const index: AnchorIndex = { ids: new Set(), names: new Set(), hrefs: new Set() };
  const $ = cheerio.load(html);
  $("[id], a[name], [href]").each((_, element) => {
    const { id, name, href } = element.attribs;
    if (id !== undefined) index.ids.add(id);
    if (name !== undefined && element.tagName === "a") index.names.add(name);
    if (href !== undefined) index.hrefs.add(href);
  });
  return index;
};

/**
 * Checks if the hash points to an element in the anchor index of a page.
 * Compares attribute values directly instead of building selectors, so no hash value can break the check.
 * GitHub code line links (`#L12`) are checked with the GitHub API (fetch never sees a github.com blob page, and
 * GitHub renders lines client-side anyway), not against this index.
 * @param index - anchor index of the page, see `buildAnchorIndex`
 * @param hash - the hash, with or without the leading `#`
 */
export const isHashInAnchorIndex = (index: AnchorIndex, hash: string): boolean => {
  const variants = getHashVariants(hash);
  if (variants.some((variant) => index.ids.has(variant) || index.names.has(variant))) {
    return true;
  }
  return variants.some(
    (variant) => index.hrefs.has(`#${variant}`) || index.hrefs.has(`#${variant.toLowerCase()}`),
  );
};
