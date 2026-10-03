import { stripHash } from "../src/link_common";
import { compareStrings } from "../src/utils";

/**
 * Groups items that share the same page (URL without hash). Hashes on the same page share a fetch or Playwright
 * navigation, so a sample must keep a page's links together instead of picking individual links.
 */
export const groupByPage = <T extends { href: string }>(items: T[]): T[][] => {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const pageUrl = stripHash(item.href);
    const group = groups.get(pageUrl);
    if (group) {
      group.push(item);
    } else {
      groups.set(pageUrl, [item]);
    }
  }
  return [...groups.values()];
};

/** Deterministically picks `count` groups out of `groups`, evenly spaced after sorting by `key` */
const pickEvenlySpaced = <T>(groups: T[], count: number, key: (group: T) => string): T[] => {
  if (groups.length <= count) {
    return groups;
  }
  const sorted = groups.toSorted((a, b) => compareStrings(key(a), key(b)));
  const picked: T[] = [];
  for (let i = 0; i < count; i++) {
    const group = sorted[Math.floor((i * sorted.length) / count)];
    if (group !== undefined) {
      picked.push(group);
    }
  }
  return picked;
};

/** Groups `items` by `getSource`, preserving first-appearance order of sources */
const groupBySource = <T>(items: T[], getSource: (item: T) => string): Map<string, T[]> => {
  const bySource = new Map<string, T[]>();
  for (const item of items) {
    const source = getSource(item);
    const list = bySource.get(source);
    if (list) {
      list.push(item);
    } else {
      bySource.set(source, [item]);
    }
  }
  return bySource;
};

/**
 * Picks the same fraction (`sampleRate`) of page groups (URL without hash, every original link entry kept) from
 * every source, so the sample's mix of sources, check paths (fetch / GitHub API / Playwright), hash vs no hash and
 * duplicate-link ratios matches the full population instead of being skewed towards any one of them. Sampling each
 * source separately (instead of the combined pool) is what keeps the mix representative: a source with few page
 * groups would otherwise be crowded out by a source with many.
 */
export const proportionalSample = <T extends { href: string }>(
  items: T[],
  getSource: (item: T) => string,
  sampleRate: number,
): T[] => {
  const picked: T[][] = [];
  for (const sourceItems of groupBySource(items, getSource).values()) {
    const groups = groupByPage(sourceItems);
    const count = Math.max(1, Math.round(groups.length * sampleRate));
    picked.push(...pickEvenlySpaced(groups, count, (group) => stripHash(group[0]?.href ?? "")));
  }
  return picked.flat();
};
