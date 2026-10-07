import { lookup } from "node:dns";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  assertDestinationAllowed,
  DestinationNotAllowedError,
  isBlockedHostLiteral,
  isNonPublicAddress,
} from "./destination";
import { checkLinkWithFetch } from "./fetch_check";
import { fetchWithHostLimit } from "./http";
import { checkLinks, shouldRecheckWithPlaywright } from "./link";
import { checkLinkWithPlaywright } from "./playwright_check";
import { setHostLimiter, withRun } from "./run";

// `node:dns` is mocked for all unit tests (src/test_setup.ts), undici resolves names through it
const mockedLookup = vi.mocked(lookup);
const resolvesTo = (addresses: Record<string, string[]>) =>
  mockedLookup.mockImplementation(((
    host: string,
    _options: object,
    callback: (error: null, found: Array<{ address: string; family: number }>) => void,
  ) =>
    callback(
      null,
      (addresses[host] ?? ["93.184.215.14"]).map((address) => ({
        address,
        family: address.includes(":") ? 6 : 4,
      })),
    )) as unknown as typeof lookup);

/** A server on 127.0.0.1 that counts the requests it gets, to prove a request was (not) sent */
const startServer = async () => {
  const requests = vi.fn();
  const server = http.createServer((_request, response) => {
    requests();
    response.end("secret");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => void server.close());
  return { requests, port: (server.address() as AddressInfo).port };
};

/** `fetch` really connects (by default tests stub it) */
const useRealFetch = async () =>
  vi.stubGlobal("fetch", (await vi.importActual<typeof import("undici")>("undici")).fetch);

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  resolvesTo({});
});

afterEach(() => {
  setHostLimiter(undefined);
  vi.restoreAllMocks();
});

describe("isNonPublicAddress()", () => {
  it.each([
    // IPv4
    "0.0.0.0",
    "0.1.2.3",
    "10.0.0.1",
    "10.255.255.255",
    "100.64.0.1",
    "100.127.255.255",
    "127.0.0.1",
    "127.1.2.3",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "192.0.0.8",
    "198.18.0.1",
    "224.0.0.1",
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255",
    // IPv6
    "::",
    "::1",
    "fe80::1",
    "febf::1",
    "fc00::1",
    "fd12:3456:789a::1",
    "ff02::1",
    "fec0::1",
    "2001:db8::1",
    // IPv4-mapped and embedded forms
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "::ffff:10.0.0.1",
    "::127.0.0.1",
    "::ffff:0:192.168.0.1",
    "64:ff9b::10.0.0.1",
    "2002:c0a8:0101::1",
    "fe80::1%eth0",
    // IPv4-compatible, IPv4-translated, NAT64 and 6to4 forms are blocked wholesale, public addresses too
    "::8.8.8.8",
    "::ffff:0:8.8.8.8",
    "64:ff9b::8.8.8.8",
    "2002:0808:0808::1",
    // Not an IP address: fail closed
    "not-an-ip",
  ])("%s is non-public", (address) => {
    expect(isNonPublicAddress(address)).toBe(true);
  });

  it.each([
    "1.1.1.1",
    "8.8.8.8",
    "93.184.215.14",
    "100.63.255.255",
    "100.128.0.1",
    "172.15.255.255",
    "172.32.0.1",
    "169.253.1.1",
    "192.169.0.1",
    "223.255.255.255",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "::ffff:8.8.8.8",
  ])("%s is public", (address) => {
    expect(isNonPublicAddress(address)).toBe(false);
  });
});

describe("isBlockedHostLiteral()", () => {
  it.each([
    "localhost",
    "LOCALHOST",
    "localhost.",
    "app.localhost",
    "[::1]",
    "127.0.0.1",
    "10.1.2.3",
  ])("blocks %s", (host) => {
    expect(isBlockedHostLiteral(host)).toBe(true);
  });

  it.each(["example.com", "localhost.example.com", "notlocalhost", "8.8.8.8", "[2606:4700::1]"])(
    "does not block %s without resolving it",
    (host) => {
      expect(isBlockedHostLiteral(host)).toBe(false);
    },
  );
});

describe("assertDestinationAllowed()", () => {
  it("blocks IP literals and localhost names", () => {
    for (const url of [
      "http://127.0.0.1/",
      "http://[::ffff:127.0.0.1]/",
      "http://0x7f.1/", // 127.0.0.1
      "http://localhost:8080/",
      "https://api.localhost/",
    ]) {
      expect(() => assertDestinationAllowed(url), url).toThrow(DestinationNotAllowedError);
    }
  });

  it("allows other names and public IPs (names are checked when connecting)", () => {
    expect(() => assertDestinationAllowed("https://example.com/")).not.toThrow();
    expect(() => assertDestinationAllowed("https://8.8.8.8/")).not.toThrow();
  });

  it("allows everything with allowPrivateHosts (--allow-private-hosts / LINK_CHECK_ALLOW_PRIVATE_HOSTS, opt-out)", async () => {
    await withRun({ allowPrivateHosts: true }, async () => {
      expect(() => assertDestinationAllowed("http://localhost:3000/")).not.toThrow();
    });
    expect(() => assertDestinationAllowed("http://localhost:3000/")).toThrow(
      DestinationNotAllowedError,
    );
  });
});

describe("fetchWithHostLimit() destination guard", () => {
  it("never sends a request to a blocked literal", async () => {
    const fetchMock = vi.fn(async () => new Response("secret"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      fetchWithHostLimit("http://169.254.169.254/latest/meta-data/", {}, (r) => r.text()),
    ).rejects.toThrow(DestinationNotAllowedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks a redirect to a private literal at the hop, it is never requested", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      String(input).startsWith("https://public.example/")
        ? new Response("", { status: 302, headers: { Location: "http://192.168.1.10/admin" } })
        : new Response("secret"),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      fetchWithHostLimit("https://public.example/start", {}, (r) => r.text()),
    ).rejects.toThrow("Destination not allowed (private or local address): 192.168.1.10");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows redirects to private hosts with the opt-out", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      String(input).startsWith("https://public.example/")
        ? new Response("", { status: 302, headers: { Location: "http://127.0.0.1:3000/" } })
        : new Response("dev server"),
    );
    vi.stubGlobal("fetch", fetchMock);
    const response = await withRun({ allowPrivateHosts: true }, () =>
      fetchWithHostLimit("https://public.example/", {}, (r) => r.text()),
    );
    expect(response.data).toBe("dev server");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("fetchWithHostLimit() connect-time check (DNS rebinding)", () => {
  it.each([
    ["a private address", ["127.0.0.1"]],
    ["a public and a private address", ["93.184.215.14", "127.0.0.1"]],
    ["a private IPv6 address", ["::1"]],
  ])("blocks a name resolving to %s, the server gets no request", async (_name, addresses) => {
    const server = await startServer();
    await useRealFetch();
    resolvesTo({ "rebind.attacker.example": addresses });
    await expect(
      fetchWithHostLimit(`http://rebind.attacker.example:${server.port}/`, {}, (r) => r.text()),
    ).rejects.toThrow(
      "Destination not allowed (private or local address): rebind.attacker.example",
    );
    expect(server.requests).not.toHaveBeenCalled();
  });

  it("does not block with allowPrivateHosts", async () => {
    const server = await startServer();
    await useRealFetch();
    const response = await withRun({ allowPrivateHosts: true }, () =>
      fetchWithHostLimit(`http://127.0.0.1:${server.port}/`, {}, (r) => r.text()),
    );
    expect(response.data).toBe("secret");
    expect(server.requests).toHaveBeenCalledTimes(1);
  });
});

describe("link checks with blocked destinations", () => {
  it("reports a blocked link as 'could not check', not broken, and never re-checks it in a browser", async () => {
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const result = await checkLinkWithFetch("http://10.0.0.1/admin");
    expect(result).toEqual({
      ok: false,
      error: "could not check",
      errorDetail: "Destination not allowed (private or local address): 10.0.0.1",
      destinationBlocked: true,
    });
    expect(shouldRecheckWithPlaywright(result, "fetch")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checkLinks: links blocked when connecting or before are 'could not check' results", async () => {
    const server = await startServer();
    await useRealFetch();
    resolvesTo({ "rebind.attacker.example": ["127.0.0.1"] });
    const results = await checkLinks({
      links: [
        { page: "README.md", href: `http://rebind.attacker.example:${server.port}/`, text: "a" },
        { page: "README.md", href: "http://[fd00::1]/#x", text: "b" },
      ],
    });
    const byHref = Object.fromEntries(results.map((link) => [link.href, link.result]));
    expect(byHref[`http://rebind.attacker.example:${server.port}/`]).toMatchObject({
      ok: false,
      error: "could not check",
      destinationBlocked: true,
    });
    expect(byHref["http://[fd00::1]/#x"]).toMatchObject({ error: "could not check" });
    expect(server.requests).not.toHaveBeenCalled();
  });

  it("Playwright checks refuse a private literal without launching a browser", async () => {
    const launch = vi.spyOn(chromium, "launch");
    expect(await checkLinkWithPlaywright("http://169.254.169.254/#x")).toMatchObject({
      ok: false,
      error: "could not check",
      destinationBlocked: true,
    });
    expect(launch).not.toHaveBeenCalled();
  });
});
