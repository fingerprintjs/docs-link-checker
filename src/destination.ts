import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { isPrivateHostsAllowed, runCached } from "./run";

/**
 * Destination policy (SSRF protection): links come from documents that can be untrusted (for example markdown in a
 * pull request checked by the reusable action), so requests to non-public addresses are never sent:
 * loopback, unspecified, private, link-local (cloud metadata `169.254.169.254`), CGNAT, unique local, multicast,
 * reserved ranges, their IPv4-mapped (and similar embedded IPv4) IPv6 forms, and `localhost` / `*.localhost`.
 *
 * - `fetchWithHostLimit` (the only `fetch` caller) checks every hop, the first request and every redirect:
 *   IP literals directly, host names by resolving them (`dns.lookup`, all addresses) and blocking if ANY
 *   address is non-public.
 * - Playwright only re-checks links that already passed the fetch pass (blocked links are never re-checked). Its
 *   route handler additionally aborts requests to blocked IP literals and localhost names (redirects, page
 *   resources), without resolving host names.
 * - Limitation: `fetch` resolves the name again when connecting, so a DNS rebinding attack (a name answering
 *   with a public address to the check and a private one right after) is not prevented. That would need
 *   connecting to the checked address, which Node's built-in `fetch` doesn't allow without extra dependencies.
 * - IPv4-compatible (`::a.b.c.d`), IPv4-translated (`::ffff:0:a.b.c.d`), NAT64 (`64:ff9b::a.b.c.d`) and 6to4
 *   (`2002:a.b.c.d::`) forms are blocked wholesale, including ones embedding a public IPv4 address: docs never
 *   link to them, and `net.BlockList` has no way to unwrap them to apply the IPv4 rules (unlike the IPv4-mapped
 *   form `::ffff:a.b.c.d`, which it unwraps on its own).
 *
 * Set `LINK_CHECK_ALLOW_PRIVATE_HOSTS=true` (CLI `--allow-private-hosts`) to allow them, e.g. to check a local
 * dev server. Only do that for trusted documents.
 */

const DESTINATION_NOT_ALLOWED = "Destination not allowed (private or local address)";

/** Thrown by `fetchWithHostLimit` for a blocked destination, the request is never sent */
export class DestinationNotAllowedError extends Error {
  override name = "DestinationNotAllowedError";
  constructor(readonly host: string) {
    super(`${DESTINATION_NOT_ALLOWED}: ${host}`);
  }
}

const blockedAddresses = new BlockList();
const addIPv4 = (net: string, prefix: number) => blockedAddresses.addSubnet(net, prefix, "ipv4");
const addIPv6 = (net: string, prefix: number) => blockedAddresses.addSubnet(net, prefix, "ipv6");

addIPv4("0.0.0.0", 8); // "this network" (unspecified)
addIPv4("10.0.0.0", 8); // private
addIPv4("127.0.0.0", 8); // loopback
addIPv4("100.64.0.0", 10); // CGNAT
addIPv4("169.254.0.0", 16); // link-local (cloud metadata)
addIPv4("172.16.0.0", 12); // private
addIPv4("192.168.0.0", 16); // private
addIPv4("192.0.0.0", 24); // IETF protocol assignments
addIPv4("198.18.0.0", 15); // benchmarking
addIPv4("224.0.0.0", 4); // multicast
addIPv4("240.0.0.0", 4); // reserved, incl. broadcast 255.255.255.255

// `net.BlockList` matches an IPv4-mapped address (`::ffff:a.b.c.d`) against the IPv4 rules above automatically.
addIPv6("0:0:0:0:0:0:0:0", 128); // unspecified ::
addIPv6("0:0:0:0:0:0:0:1", 128); // loopback ::1
addIPv6("fe80::", 10); // link-local
addIPv6("fec0::", 10); // deprecated site-local
addIPv6("fc00::", 7); // unique local
addIPv6("ff00::", 8); // multicast
addIPv6("2001:db8::", 32); // documentation
addIPv6("0:0:0:0:0:0:0:0", 96); // IPv4-compatible ::a.b.c.d
addIPv6("0:0:0:0:ffff:0:0:0", 96); // IPv4-translated ::ffff:0:a.b.c.d
addIPv6("64:ff9b:0:0:0:0:0:0", 96); // NAT64
addIPv6("2002:0:0:0:0:0:0:0", 16); // 6to4

/** Is the IP address non-public? Anything that is not a valid IP address counts as non-public (fail closed). */
export const isNonPublicAddress = (address: string): boolean => {
  const version = isIP(address);
  if (version === 4) return blockedAddresses.check(address, "ipv4");
  if (version === 6) return blockedAddresses.check(address, "ipv6");
  return true;
};

/** Host name of a URL without IPv6 brackets and the trailing dot, lowercase */
const normalizeHostname = (hostname: string) =>
  hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();

/**
 * Is the host blocked without resolving it: `localhost`, `*.localhost` or a non-public IP literal
 * (URL parsing already normalizes IPv4 forms like `2130706433` or `0x7f.1` to `127.0.0.1`).
 */
export const isBlockedHostLiteral = (hostname: string): boolean => {
  const host = normalizeHostname(hostname);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  return isIP(host) !== 0 && isNonPublicAddress(host);
};

/** For the Playwright route handler: is the URL's host a blocked literal (and private hosts are not allowed)? */
export const isBlockedUrlLiteral = (url: string, allowPrivateHosts = isPrivateHostsAllowed()) => {
  if (allowPrivateHosts) return false;
  try {
    return isBlockedHostLiteral(new URL(url).hostname);
  } catch {
    return false;
  }
};

type LookupAll = (hostname: string) => Promise<Array<{ address: string }>>;
const lookupAll: LookupAll = (hostname) => lookup(hostname, { all: true, order: "verbatim" });

/**
 * Throws `DestinationNotAllowedError` if the URL's host is blocked: a blocked literal, or a name with ANY
 * non-public address. Name resolution failures are not blocked (the request then fails like any unknown host).
 * Resolutions are cached for the run.
 */
export const assertDestinationAllowed = async (
  url: string,
  allowPrivateHosts = isPrivateHostsAllowed(),
): Promise<void> => {
  if (allowPrivateHosts) return;
  let hostname: string;
  try {
    hostname = normalizeHostname(new URL(url).hostname);
  } catch {
    return; // Invalid URLs fail in fetch
  }
  if (hostname === "") return;
  if (isBlockedHostLiteral(hostname)) {
    throw new DestinationNotAllowedError(hostname);
  }
  if (isIP(hostname) !== 0) return; // A public IP literal
  const addresses = await runCached(`dns ${hostname}`, () => lookupAll(hostname)).catch(
    () => undefined,
  );
  if (addresses?.some(({ address }) => isNonPublicAddress(address))) {
    throw new DestinationNotAllowedError(hostname);
  }
};
