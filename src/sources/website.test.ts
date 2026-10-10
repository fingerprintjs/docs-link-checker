import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { checkWebsite, createPrefixFilter } from "./website";

const PAGE_COUNT = 20;

// Local site: a sitemap with PAGE_COUNT pages, each linking to one working and one missing URL
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const send = (status: number, body = "") => {
      res.writeHead(status, { "content-type": "text/html" });
      res.end(body);
    };
    if (req.url === "/sitemap.xml") {
      const urls = Array.from({ length: PAGE_COUNT }, (_, i) => `${base}/page-${i}`);
      send(200, `<urlset>${urls.map((url) => `<url><loc>${url}</loc></url>`).join("")}</urlset>`);
    } else if (req.url?.startsWith("/page-")) {
      send(200, `<a href="/ok">ok</a><a href="/missing">missing</a>`);
    } else {
      send(req.url === "/ok" ? 200 : 404);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server has no port");
  }
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

const pagesOf = (results: { page: string }[]) => new Set(results.map((link) => link.page));

describe("checkWebsite()", () => {
  it("checks the links of all sitemap pages", async () => {
    vi.stubEnv("LINK_CHECK_SAMPLE_RATE", "");
    const results = await checkWebsite({ websiteUrl: base });
    expect(pagesOf(results).size).toBe(PAGE_COUNT);
    expect(results.filter((link) => link.href === `${base}/ok`).every((l) => l.result.ok)).toBe(
      true,
    );
    expect(results.find((link) => link.href === `${base}/missing`)?.result).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
    });
  });

  it("checks only a sample of the pages with the sampleRate option, over LINK_CHECK_SAMPLE_RATE", async () => {
    vi.stubEnv("LINK_CHECK_SAMPLE_RATE", "0.1");
    const results = await checkWebsite({ websiteUrl: base, sampleRate: 0.2 });
    expect(pagesOf(results).size).toBe(4);
  });

  it("keeps only the links accepted by the link filter", async () => {
    const results = await checkWebsite({
      websiteUrl: base,
      sampleRate: 0.1,
      linkFilter: createPrefixFilter(["https://other.example", `${base}/ok`]),
    });
    expect(results.map((link) => link.href)).toEqual([`${base}/ok`, `${base}/ok`]);
  });
});
