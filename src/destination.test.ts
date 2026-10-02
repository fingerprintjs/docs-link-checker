import { lookup } from "node:dns/promises";
import { chromium } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// `node:dns/promises` is mocked for all unit tests (src/test_setup.ts)
const mockedLookup = vi.mocked(lookup) as unknown as ReturnType<
  typeof vi.fn<
    (host: string, options: object) => Promise<Array<{ address: string; family: number }>>
  >
>;
const resolvesTo = (addresses: Record<string, string[]>) =>
  mockedLookup.mockImplementation(async (host: string) =>
    (addresses[host] ?? ["93.184.215.14"]).map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    })),
  );

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
  it("blocks IP literals and localhost names without resolving them", async () => {
    for (const url of [
      "http://127.0.0.1/",
      "http://[::ffff:127.0.0.1]/",
      "http://0x7f.1/", // 127.0.0.1
      "http://localhost:8080/",
      "https://api.localhost/",
    ]) {
      await expect(assertDestinationAllowed(url), url).rejects.toThrow(DestinationNotAllowedError);
    }
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it("blocks a name resolving to the cloud metadata address", async () => {
    resolvesTo({ "metadata.attacker.example": ["169.254.169.254"] });
    await expect(
      assertDestinationAllowed("http://metadata.attacker.example/latest/"),
    ).rejects.toThrow(
      "Destination not allowed (private or local address): metadata.attacker.example",
    );
    expect(mockedLookup).toHaveBeenCalledWith(
      "metadata.attacker.example",
      expect.objectContaining({ all: true }),
    );
  });

  it("blocks a name if ANY of its addresses is non-public", async () => {
    resolvesTo({ "mixed.example": ["93.184.215.14", "10.0.0.5"], "v6.example": ["fd00::1"] });
    await expect(assertDestinationAllowed("https://mixed.example/")).rejects.toThrow(
      DestinationNotAllowedError,
    );
    await expect(assertDestinationAllowed("https://v6.example/")).rejects.toThrow(
      DestinationNotAllowedError,
    );
  });

  it("allows public names and IPs, and names that don't resolve (fetch then fails as usual)", async () => {
    await expect(assertDestinationAllowed("https://example.com/")).resolves.toBeUndefined();
    await expect(assertDestinationAllowed("https://8.8.8.8/")).resolves.toBeUndefined();
    mockedLookup.mockRejectedValueOnce(
      Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }),
    );
    await expect(assertDestinationAllowed("https://nxdomain.example/")).resolves.toBeUndefined();
  });

  it("allows everything with allowPrivateHosts (--allow-private-hosts / LINK_CHECK_ALLOW_PRIVATE_HOSTS, opt-out)", async () => {
    resolvesTo({ "dev.internal": ["10.0.0.5"] });
    await withRun({ allowPrivateHosts: true }, async () => {
      await expect(assertDestinationAllowed("http://localhost:3000/")).resolves.toBeUndefined();
      await expect(assertDestinationAllowed("http://dev.internal/")).resolves.toBeUndefined();
    });
    await expect(assertDestinationAllowed("http://localhost:3000/")).rejects.toThrow(
      DestinationNotAllowedError,
    );
  });
});

describe("fetchWithHostLimit() destination guard", () => {
  it("never sends a request to a blocked destination", async () => {
    const fetchMock = vi.fn(async () => new Response("secret"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      fetchWithHostLimit("http://169.254.169.254/latest/meta-data/", {}, (r) => r.text()),
    ).rejects.toThrow(DestinationNotAllowedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks a redirect to a private host at the hop, the private host is never requested", async () => {
    resolvesTo({ "internal.corp.example": ["192.168.1.10"] });
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      String(input).startsWith("https://public.example/")
        ? new Response("", {
            status: 302,
            headers: { Location: "http://internal.corp.example/admin" },
          })
        : new Response("secret"),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      fetchWithHostLimit("https://public.example/start", {}, (r) => r.text()),
    ).rejects.toThrow("Destination not allowed (private or local address): internal.corp.example");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://public.example/start");
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

  it("checkLinks: blocked links are 'could not check' results, other links are checked", async () => {
    resolvesTo({ "rebind.attacker.example": ["127.0.0.1"] });
    const fetchMock = vi.fn(
      async (_input: string | URL | Request) => new Response("<html></html>"),
    );
    vi.stubGlobal("fetch", fetchMock);
    const results = await checkLinks({
      links: [
        { page: "README.md", href: "http://rebind.attacker.example/", text: "a" },
        { page: "README.md", href: "http://[fd00::1]/#x", text: "b" },
        { page: "README.md", href: "https://example.com/", text: "c" },
      ],
    });
    const byHref = Object.fromEntries(results.map((link) => [link.href, link.result]));
    expect(byHref["http://rebind.attacker.example/"]).toMatchObject({
      ok: false,
      error: "could not check",
      destinationBlocked: true,
    });
    expect(byHref["http://[fd00::1]/#x"]).toMatchObject({ error: "could not check" });
    expect(byHref["https://example.com/"]).toMatchObject({ ok: true });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(["https://example.com/"]);
  });

  it("Playwright checks refuse a name resolving to a private address without launching a browser", async () => {
    resolvesTo({ "metadata.attacker.example": ["169.254.169.254"] });
    const launch = vi.spyOn(chromium, "launch");
    expect(await checkLinkWithPlaywright("http://metadata.attacker.example/#x")).toMatchObject({
      ok: false,
      error: "could not check",
      destinationBlocked: true,
    });
    expect(launch).not.toHaveBeenCalled();
  });
});
