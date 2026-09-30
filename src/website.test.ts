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

import { checkWebsite } from "./website";

const pages = Array.from({ length: 20 }, (_, i) => `https://example.com/page-${String(i).padStart(2, "0")}`);

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  mocks.getWebsitePages.mockReset().mockResolvedValue([...pages].reverse());
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
    expect(mocks.getLinksFromPages.mock.calls[0][0].pages).toHaveLength(20);
  });

  it("checks a deterministic sample of pages with LINK_CHECK_SAMPLE_RATE", async () => {
    vi.stubEnv("LINK_CHECK_SAMPLE_RATE", "0.1");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await checkWebsite({ websiteUrl: "https://example.com" });

    expect(mocks.getLinksFromPages.mock.calls[0][0].pages).toEqual([pages[0], pages[10]]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Sampling 2 of 20 pages"));
  });
});
