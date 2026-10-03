import { stripHash } from "../src/link_common";
import type { Composition } from "./types";

type Summarizable = { href: string; source: string; checkedWith?: string };

/** Counts links, unique URLs and pages (overall, by source and by check method), see `Composition` */
export const summarizeComposition = (items: Summarizable[]): Composition => {
  const bySource: Record<string, number> = {};
  const byCheckedWith: Record<string, number> = {};
  for (const item of items) {
    bySource[item.source] = (bySource[item.source] ?? 0) + 1;
    const checkedWith = item.checkedWith ?? "unknown";
    byCheckedWith[checkedWith] = (byCheckedWith[checkedWith] ?? 0) + 1;
  }
  return {
    linkCount: items.length,
    uniqueUrlCount: new Set(items.map((item) => item.href)).size,
    pageCount: new Set(items.map((item) => stripHash(item.href))).size,
    bySource,
    byCheckedWith,
  };
};
