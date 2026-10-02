import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { runCached } from "./run_context";

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
 *
 * Set `LINK_CHECK_ALLOW_PRIVATE_HOSTS=true` (CLI `--allow-private-hosts`) to allow them, e.g. to check a local
 * dev server. Only do that for trusted documents.
 */

const DESTINATION_NOT_ALLOWED = "Destination not allowed (private or local address)";

export const isPrivateHostsAllowed = (value = process.env.LINK_CHECK_ALLOW_PRIVATE_HOSTS) =>
  value === "true";

/** Thrown by `fetchWithHostLimit` for a blocked destination, the request is never sent */
export class DestinationNotAllowedError extends Error {
  override name = "DestinationNotAllowedError";
  constructor(readonly host: string) {
    super(`${DESTINATION_NOT_ALLOWED}: ${host}`);
  }
}

const parseIPv4 = (address: string): number[] | undefined => {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  const bytes = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return bytes.every((byte) => byte >= 0 && byte <= 255) ? bytes : undefined;
};

/** Non-public IPv4 ranges, by the first bytes of the address (4 bytes, see `parseIPv4`) */
const isNonPublicIPv4 = ([a = 0, b = 0, c = 0]: number[]): boolean =>
  a === 0 || // "this network" 0.0.0.0/8 (unspecified)
  a === 10 || // private 10/8
  a === 127 || // loopback 127/8
  (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
  (a === 169 && b === 254) || // link-local 169.254/16 (cloud metadata)
  (a === 172 && b >= 16 && b <= 31) || // private 172.16/12
  (a === 192 && b === 168) || // private 192.168/16
  (a === 192 && b === 0 && c === 0) || // IETF protocol assignments 192.0.0/24
  (a === 198 && (b === 18 || b === 19)) || // benchmarking 198.18/15
  a >= 224; // multicast 224/4, reserved 240/4 and broadcast

const toGroups = (part: string): number[] =>
  part === ""
    ? []
    : part
        .split(":")
        .map((group) => (/^[\da-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : Number.NaN));

/** Expands an IPv6 address to 8 16-bit groups (also with an embedded dotted IPv4 tail), `undefined` if invalid */
export const parseIPv6 = (address: string): number[] | undefined => {
  let text = address.toLowerCase();
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);

  // `::ffff:1.2.3.4`: the dotted IPv4 tail is the last two groups
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  if (text.slice(lastColon + 1).includes(".")) {
    const ipv4 = parseIPv4(text.slice(lastColon + 1));
    if (!ipv4) return undefined;
    const [b0 = 0, b1 = 0, b2 = 0, b3 = 0] = ipv4;
    tail = [(b0 << 8) | b1, (b2 << 8) | b3];
    text = text.slice(0, lastColon + 1);
    if (!text.endsWith("::")) text = text.slice(0, -1);
  }

  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  let groups: number[];
  const [headText = "", restText] = halves;
  if (restText !== undefined) {
    const [head, rest] = [toGroups(headText), toGroups(restText)];
    const missing = 8 - tail.length - head.length - rest.length;
    if (missing < 0) return undefined;
    groups = [...head, ...Array.from({ length: missing }, () => 0), ...rest];
  } else {
    groups = toGroups(text);
  }
  groups = [...groups, ...tail];
  return groups.length === 8 && groups.every((group) => group >= 0 && group <= 0xffff)
    ? groups
    : undefined;
};

const embeddedIPv4 = (high: number, low: number) => [high >> 8, high & 0xff, low >> 8, low & 0xff];

/** @param groups the 8 groups of the address (see `parseIPv6`) */
const isNonPublicIPv6 = (groups: number[]): boolean => {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const firstSixZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (firstSixZero && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) {
    return true; // unspecified :: and loopback ::1
  }
  if (firstSixZero && (g5 === 0xffff || g5 === 0)) {
    return isNonPublicIPv4(embeddedIPv4(g6, g7)); // IPv4-mapped ::ffff:a.b.c.d, IPv4-compatible ::a.b.c.d
  }
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) {
    return isNonPublicIPv4(embeddedIPv4(g6, g7)); // IPv4-translated ::ffff:0:a.b.c.d
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isNonPublicIPv4(embeddedIPv4(g6, g7)); // NAT64 64:ff9b::a.b.c.d
  }
  if (g0 === 0x2002) {
    return isNonPublicIPv4(embeddedIPv4(g1, g2)); // 6to4 2002:a.b.c.d::
  }
  return (
    (g0 & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (g0 & 0xffc0) === 0xfec0 || // deprecated site-local fec0::/10
    (g0 & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (g0 & 0xff00) === 0xff00 || // multicast ff00::/8
    (g0 === 0x2001 && g1 === 0xdb8) // documentation 2001:db8::/32
  );
};

/** Is the IP address non-public? Anything that is not a valid IP address counts as non-public (fail closed). */
export const isNonPublicAddress = (address: string): boolean => {
  const version = isIP(address);
  if (version === 4) {
    const bytes = parseIPv4(address);
    return bytes === undefined || isNonPublicIPv4(bytes);
  }
  if (version === 6) {
    const groups = parseIPv6(address);
    return groups === undefined || isNonPublicIPv6(groups);
  }
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
