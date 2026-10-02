import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getWebsitePages: vi.fn(),
  getLinksFromPages: vi.fn(),
  checkLinks: vi.fn(),
  saveReport: vi.fn(),
}));

vi.mock("./sitemap", () => ({ getWebsitePages: mocks.getWebsitePages }));
vi.mock("./page", () => ({ getLinksFromPages: mocks.getLinksFromPages }));
vi.mock("./link", () => ({ checkLinks: mocks.checkLinks }));
vi.mock("./report/report", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./report/report")>()),
  saveReport: mocks.saveReport,
}));

import { createBaseline } from "./baseline";
import { checkWebsite, createPrefixFilter } from "./website";

const pages = Array.from(
  { length: 20 },
  (_, i) => `https://example.com/page-${String(i).padStart(2, "0")}`,
);

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  mocks.getWebsitePages.mockReset().mockResolvedValue(pages.toReversed());
  mocks.getLinksFromPages.mockReset().mockResolvedValue({ links: [], errors: [] });
  mocks.checkLinks.mockReset().mockResolvedValue({ results: [], errors: [] });
  mocks.saveReport.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("checkWebsite() sampling", () => {
  it("checks all pages by default", async () => {
    vi.stubEnv("LINK_CHECK_SAMPLE_RATE", "");
    await checkWebsite({ websiteUrl: "https://example.com" });
    expect(mocks.getLinksFromPages.mock.calls[0]![0].pages).toHaveLength(20);
  });

  it("checks a deterministic sample of pages with LINK_CHECK_SAMPLE_RATE", async () => {
    vi.stubEnv("LINK_CHECK_SAMPLE_RATE", "0.1");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await checkWebsite({ websiteUrl: "https://example.com" });

    expect(mocks.getLinksFromPages.mock.calls[0]![0].pages).toEqual([pages[0], pages[10]]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Sampling 2 of 20 pages"));
  });

  it("uses the sampleRate option over LINK_CHECK_SAMPLE_RATE", async () => {
    vi.stubEnv("LINK_CHECK_SAMPLE_RATE", "0.1");
    await checkWebsite({ websiteUrl: "https://example.com", sampleRate: 0.2 });
    expect(mocks.getLinksFromPages.mock.calls[0]![0].pages).toHaveLength(4);
  });
});

describe("checkWebsite() options", () => {
  it("saves the report to the output directory, or not at all", async () => {
    await checkWebsite({ websiteUrl: "https://example.com" });
    expect(mocks.saveReport).toHaveBeenCalledWith(expect.anything(), "results");
    await checkWebsite({ websiteUrl: "https://example.com", outputDir: "out" });
    expect(mocks.saveReport).toHaveBeenLastCalledWith(expect.anything(), "out");
    mocks.saveReport.mockClear();
    await checkWebsite({ websiteUrl: "https://example.com", outputDir: false });
    expect(mocks.saveReport).not.toHaveBeenCalled();
  });

  it("applies the baseline to the report", async () => {
    mocks.checkLinks.mockResolvedValue({
      results: [
        {
          href: "https://example.com/broken",
          page: pages[0],
          text: "",
          result: { ok: false, error: "broken link", status: 404 },
        },
      ],
      errors: [],
    });
    const report = await checkWebsite({
      websiteUrl: "https://example.com",
      baseline: createBaseline([{ pattern: "https://example.com/**" }]),
    });
    expect(report.summary).toMatchObject({ totalLinksToFix: 0, ignored: 1 });
  });
});

describe("createPrefixFilter()", () => {
  it("keeps links starting with one of the prefixes", () => {
    const filter = createPrefixFilter(["https://a.com", "https://github.com"]);
    expect(filter({ href: "https://a.com/x", page: "", text: "" })).toBe(true);
    expect(filter({ href: "https://github.com/x", page: "", text: "" })).toBe(true);
    expect(filter({ href: "https://b.com/", page: "", text: "" })).toBe(false);
  });
});
