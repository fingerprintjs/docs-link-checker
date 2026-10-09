/**
 * Plain-text vocabulary shared by all outputs (CLI, HTML report, job summary, annotations):
 * labels, one-line reasons, grouping by target link and short URLs.
 */
import type { LinkWithResult } from "../types";

/** A link that matched the baseline file, with the reason of the matching entry */
export type IgnoredLink = LinkWithResult & { ignoreReason?: string };

export const isHttpUrl = (value: string): boolean => {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

export const encodePath = (path: string): string =>
  path.split("/").map(encodeURIComponent).join("/");

/** `file:line` (or just the page) of a link */
export const formatLocation = (link: { page: string; line?: number }): string =>
  link.line ? `${link.page}:${link.line}` : link.page;

/**
 * Name of the problem of a failed link: `Anchor not found`, `Line out of range`, `File not found`, `HTTP 404`,
 * `Network error`, `Could not check (403)`. `OK` for a link that works.
 */
/** Error details of `checkLineAnchor` (src/line_anchor.ts) */
const LINE_CHECK_DETAIL = /^Invalid line anchor #|has only \d+ lines?$/;

export const problemLabel = (link: LinkWithResult): string => {
  const { result } = link;
  if (result.ok) {
    return "OK";
  }
  switch (result.error) {
    case "hash not found":
      // From the line check's message, not the hash: `#L99` on a markdown or web page is a normal anchor
      return LINE_CHECK_DETAIL.test(result.errorDetail ?? "")
        ? "Line out of range"
        : "Anchor not found";
    case "broken link":
      if (result.status) {
        return `HTTP ${result.status}`;
      }
      // Local links are only checked on the filesystem, a failed request always has a status or is a network error
      return isHttpUrl(link.href) ? "Network error" : "File not found";
    case "could not check":
      return result.status ? `Could not check (${result.status})` : "Could not check";
    case "unexpected error":
      return "Network error";
  }
};

export type ProblemKind = "ok" | "broken" | "anchor" | "network" | "check";

/** Filter category of a link, derived from its label so every output counts the same way */
export const problemKind = (link: LinkWithResult): ProblemKind => {
  const label = problemLabel(link);
  if (label === "OK") return "ok";
  if (label === "Anchor not found" || label === "Line out of range") return "anchor";
  if (label === "Network error") return "network";
  return label.startsWith("Could not check") ? "check" : "broken";
};

/** How many of the links are in each category */
export const countByKind = (links: LinkWithResult[]): Record<ProblemKind, number> => {
  const counts = { ok: 0, broken: 0, anchor: 0, network: 0, check: 0 };
  for (const link of links) {
    counts[problemKind(link)]++;
  }
  return counts;
};

const MAX_REASON_LENGTH = 100;

/** Local and GitHub messages in plain words, the label already says what failed */
const SIMPLIFIED_REASONS: Array<[RegExp, string]> = [
  [/^No heading matching (#\S+) in (.+)$/, "no heading $1 in $2"],
  [/^No heading found matching hash: (\S+)$/, "no heading #$1"],
  [/^File not found: /, "no file "],
  [/^(.+) has only (\d+ lines?)$/, "$1 has $2"],
];

/**
 * One short line about why a link failed, without repeating the label. Response bodies (HTML pages) are cut off:
 * `Not Found <!doctype html>...` becomes `Not Found`. Empty if there is nothing to add to the label.
 */
export const shortReason = (link: LinkWithResult): string => {
  const { result } = link;
  if (result.ok) {
    return "";
  }
  const detail = (result.errorDetail ?? "").split("<")[0]?.replace(/\s+/g, " ").trim() ?? "";
  if (detail === "" && result.error === "hash not found") {
    return "no element with this id";
  }
  let reason = detail;
  for (const [pattern, replacement] of SIMPLIFIED_REASONS) {
    if (pattern.test(detail)) {
      reason = detail.replace(pattern, replacement);
      break;
    }
  }
  return reason.length > MAX_REASON_LENGTH ? `${reason.slice(0, MAX_REASON_LENGTH - 1)}…` : reason;
};

const LOCAL_LINK_BASE = "https://local.invalid/";

/**
 * What the link points at.
 * An http(s) href is itself. Anything else is resolved against the page it was found on, the same way
 * `checkLocalLink` resolves it: `missing.md` in `a/README.md` and `b/README.md` are different files.
 */
const targetKey = (link: { href: string; page: string }): string => {
  if (isHttpUrl(link.href)) {
    return link.href;
  }
  try {
    if (isHttpUrl(link.page)) {
      return new URL(link.href, link.page).href;
    }
    const url = link.href.startsWith("/")
      ? new URL(link.href.replace(/^\/+/, ""), LOCAL_LINK_BASE)
      : new URL(link.href, new URL(encodePath(link.page), LOCAL_LINK_BASE));
    // Local file checks ignore the query string (`checkLocalLink`), so it does not make a different target
    return `${url.pathname}${url.hash}`;
  } catch {
    return JSON.stringify([link.page, link.href]);
  }
};

export type TargetGroup<T extends IgnoredLink> = {
  /** First link of the group, represents it (result, reason) */
  link: T;
  /** All links of the group, in input order (the pages to fix) */
  pages: T[];
};

/**
 * Groups links by target, problem label and ignore reason: fixing the target once fixes every page.
 * Most pages first, groups with the same count keep the order of first appearance.
 * The error detail is not part of the key: a bot challenge page changes on every request and would split the group.
 */
export const groupByTarget = <T extends IgnoredLink>(links: T[]): TargetGroup<T>[] => {
  const groups = new Map<string, TargetGroup<T>>();
  for (const link of links) {
    const key = JSON.stringify([targetKey(link), problemLabel(link), link.ignoreReason ?? ""]);
    const group = groups.get(key);
    if (group) {
      group.pages.push(link);
    } else {
      groups.set(key, { link, pages: [link] });
    }
  }
  return [...groups.values()].toSorted((a, b) => b.pages.length - a.pages.length);
};

/**
 * Origin of the checked site (`http://localhost:8080`), taken from the first page that is an http(s) URL.
 * The report only has a display name of the site, which has no scheme or port. Undefined for local files.
 */
export const findSiteOrigin = (links: Array<{ page: string }>): string | undefined => {
  const page = links.find((link) => isHttpUrl(link.page))?.page;
  return page ? new URL(page).origin : undefined;
};

/**
 * Short form of a URL for display: the origin of the checked site is dropped (`/reference/x#y`), `https://` is
 * dropped from other URLs. Anything that is not a URL (local file paths) is returned as is.
 * @param siteOrigin the origin or URL of the checked site
 */
export const displayUrl = (url: string, siteOrigin?: string): string => {
  if (siteOrigin && URL.canParse(url) && URL.canParse(siteOrigin)) {
    const parsed = new URL(url);
    if (parsed.origin === new URL(siteOrigin).origin) {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  }
  return url.replace(/^https:\/\//i, "");
};
