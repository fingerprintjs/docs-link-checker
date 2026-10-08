/**
 * Link checks: first pass (fetch / GitHub API), Playwright re-check of failures that the check method may cause.
 * STUB: `checkLinks` is implemented by the PIPELINE group.
 */
import { Effect } from "effect";
import type { RunServices } from "./app";
import type { Link, LinkWithResult } from "./types";

const getHostname = (href: string): string => {
  try {
    return new URL(href).hostname;
  } catch {
    return "";
  }
};

/**
 * Reorders items round-robin by host (`a1, b1, c1, a2, b2, a3...`), so a concurrency pool works on many hosts
 * at once instead of filling up with tasks waiting for the per-host limit of a single host.
 */
export const interleaveByHost = <T extends { href: string }>(items: ReadonlyArray<T>): T[] => {
  const byHost = new Map<string, T[]>();
  for (const item of items) {
    const host = getHostname(item.href);
    const hostItems = byHost.get(host);
    if (hostItems) {
      hostItems.push(item);
    } else {
      byHost.set(host, [item]);
    }
  }
  // Round-robin over the hosts that still have items: exhausted hosts are dropped, so every item is visited once
  // (O(items), not O(hosts x largest host))
  let queues = [...byHost.values()];
  const result: T[] = [];
  for (let i = 0; queues.length > 0; i++) {
    for (const queue of queues) {
      // Queues shorter than i + 1 were dropped in the previous round
      const item = queue[i];
      if (item !== undefined) {
        result.push(item);
      }
    }
    queues = queues.filter((queue) => queue.length > i + 1);
  }
  return result;
};

export const checkLinks: (args: {
  readonly links: ReadonlyArray<Link>;
  /** Default `CONCURRENCY_LIMIT` */
  readonly fetchConcurrencyLimit?: number;
}) => Effect.Effect<LinkWithResult[], never, RunServices> = () => Effect.die("not implemented");
