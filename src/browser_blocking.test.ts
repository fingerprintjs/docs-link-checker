import { describe, it, expect, vi } from "vitest";
import { Route } from "playwright";
import { blockHeavyResources, shouldBlockRequest } from "./browser";

const request = (resourceType: string, url: string, isMainFrameNavigation = false) => ({
  resourceType,
  url,
  isMainFrameNavigation,
});

describe("shouldBlockRequest()", () => {
  it.each(["image", "media", "font"])("blocks %s resources", (resourceType) => {
    expect(shouldBlockRequest(request(resourceType, "https://example.com/asset"))).toBe(true);
  });

  it.each(["script", "stylesheet", "xhr", "fetch", "document"])("allows %s resources from regular hosts", (type) => {
    expect(shouldBlockRequest(request(type, "https://example.com/app"))).toBe(false);
  });

  it.each([
    "https://www.googletagmanager.com/gtm.js?id=GTM-123",
    "https://www.google-analytics.com/analytics.js",
    "https://stats.g.doubleclick.net/r/collect",
    "https://cdn.segment.com/analytics.js/v1/abc/analytics.min.js",
    "https://api.segment.io/v1/t",
    "https://static.hotjar.com/c/hotjar-1.js",
    "https://script.hotjar.com/modules.js",
  ])("blocks analytics and tag manager requests: %s", (url) => {
    expect(shouldBlockRequest(request("script", url))).toBe(true);
    expect(shouldBlockRequest(request("xhr", url))).toBe(true);
  });

  it("matches blocked hosts exactly or as a subdomain, not as a substring", () => {
    expect(shouldBlockRequest(request("script", "https://notgoogletagmanager.com/x.js"))).toBe(false);
    expect(shouldBlockRequest(request("script", "https://example.com/googletagmanager.com.js"))).toBe(false);
  });

  it("never blocks the main frame navigation (the link being checked), even for images or blocked hosts", () => {
    expect(shouldBlockRequest(request("document", "https://www.googletagmanager.com/", true))).toBe(false);
    expect(shouldBlockRequest(request("image", "https://example.com/logo.png", true))).toBe(false);
  });

  it("blocks iframes from analytics hosts (not the main frame)", () => {
    expect(shouldBlockRequest(request("document", "https://www.googletagmanager.com/ns.html"))).toBe(true);
  });

  it("does not throw on invalid URLs", () => {
    expect(shouldBlockRequest(request("script", "not a url"))).toBe(false);
  });
});

describe("blockHeavyResources() route handler", () => {
  const fakeRoute = ({
    resourceType,
    url,
    navigation = false,
    parentFrame = null as object | null,
  }: {
    resourceType: string;
    url: string;
    navigation?: boolean;
    parentFrame?: object | null;
  }) => {
    const route = {
      request: () => ({
        resourceType: () => resourceType,
        url: () => url,
        isNavigationRequest: () => navigation,
        frame: () => ({ parentFrame: () => parentFrame }),
      }),
      abort: vi.fn(async () => {}),
      continue: vi.fn(async () => {}),
    };
    return route;
  };

  it("aborts blocked requests", async () => {
    const route = fakeRoute({ resourceType: "image", url: "https://example.com/a.png" });
    await blockHeavyResources(route as unknown as Route);
    expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(route.continue).not.toHaveBeenCalled();
  });

  it("continues other requests", async () => {
    const route = fakeRoute({ resourceType: "script", url: "https://example.com/app.js" });
    await blockHeavyResources(route as unknown as Route);
    expect(route.continue).toHaveBeenCalled();
    expect(route.abort).not.toHaveBeenCalled();
  });

  it("continues the main frame navigation", async () => {
    const route = fakeRoute({ resourceType: "document", url: "https://www.googletagmanager.com/", navigation: true });
    await blockHeavyResources(route as unknown as Route);
    expect(route.continue).toHaveBeenCalled();
  });

  it("aborts analytics iframe navigations", async () => {
    const route = fakeRoute({
      resourceType: "document",
      url: "https://www.googletagmanager.com/ns.html",
      navigation: true,
      parentFrame: {},
    });
    await blockHeavyResources(route as unknown as Route);
    expect(route.abort).toHaveBeenCalled();
  });

  it("ignores errors when the page is already closed", async () => {
    const route = fakeRoute({ resourceType: "font", url: "https://example.com/a.woff2" });
    route.abort.mockRejectedValue(new Error("Target closed"));
    await expect(blockHeavyResources(route as unknown as Route)).resolves.toBeUndefined();
  });
});
