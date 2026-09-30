import type { Route } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { blockHeavyResources, createResourceBlocker, shouldBlockRequest } from "./browser";

const request = (resourceType: string, url: string, isMainFrameNavigation = false) => ({
  resourceType,
  url,
  isMainFrameNavigation,
});

describe("shouldBlockRequest()", () => {
  it.each(["image", "media", "font"])("blocks %s resources", (resourceType) => {
    expect(shouldBlockRequest(request(resourceType, "https://example.com/asset"))).toBe(true);
  });

  it.each(["script", "stylesheet", "xhr", "fetch", "document"])(
    "allows %s resources from regular hosts",
    (type) => {
      expect(shouldBlockRequest(request(type, "https://example.com/app"))).toBe(false);
    },
  );

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
    expect(shouldBlockRequest(request("script", "https://notgoogletagmanager.com/x.js"))).toBe(
      false,
    );
    expect(
      shouldBlockRequest(request("script", "https://example.com/googletagmanager.com.js")),
    ).toBe(false);
  });

  it("never blocks the main frame navigation (the link being checked), even for images or blocked hosts", () => {
    expect(shouldBlockRequest(request("document", "https://www.googletagmanager.com/", true))).toBe(
      false,
    );
    expect(shouldBlockRequest(request("image", "https://example.com/logo.png", true))).toBe(false);
  });

  it("blocks iframes from analytics hosts (not the main frame)", () => {
    expect(
      shouldBlockRequest(request("document", "https://www.googletagmanager.com/ns.html")),
    ).toBe(true);
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

  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1:8080/",
    "http://[::1]/",
    "http://[::ffff:10.0.0.1]/",
    "http://localhost:3000/",
    "http://admin.localhost/",
    "http://2130706433/", // 127.0.0.1 in decimal, normalized by URL parsing
  ])("aborts the main navigation (and redirects) to the private destination %s", async (url) => {
    const route = fakeRoute({ resourceType: "document", url, navigation: true });
    await blockHeavyResources(route as unknown as Route);
    expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(route.continue).not.toHaveBeenCalled();
    expect(shouldBlockRequest({ resourceType: "fetch", url, isMainFrameNavigation: false })).toBe(
      true,
    );
  });

  it("allows private destinations with LINK_CHECK_ALLOW_PRIVATE_HOSTS=true", async () => {
    vi.stubEnv("LINK_CHECK_ALLOW_PRIVATE_HOSTS", "true");
    const route = fakeRoute({
      resourceType: "document",
      url: "http://localhost:3000/",
      navigation: true,
    });
    await blockHeavyResources(route as unknown as Route);
    expect(route.continue).toHaveBeenCalled();
    expect(route.abort).not.toHaveBeenCalled();
  });

  it("continues other requests", async () => {
    const route = fakeRoute({ resourceType: "script", url: "https://example.com/app.js" });
    await blockHeavyResources(route as unknown as Route);
    expect(route.continue).toHaveBeenCalled();
    expect(route.abort).not.toHaveBeenCalled();
  });

  it("continues the main frame navigation", async () => {
    const route = fakeRoute({
      resourceType: "document",
      url: "https://www.googletagmanager.com/",
      navigation: true,
    });
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

  it("createResourceBlocker() allows the vendor's own resources when the checked page is hosted by it", async () => {
    const blocker = createResourceBlocker();
    const navigation = fakeRoute({
      resourceType: "document",
      url: "https://segment.com/docs/",
      navigation: true,
    });
    const ownScript = fakeRoute({ resourceType: "script", url: "https://cdn.segment.com/app.js" });
    const tagManager = fakeRoute({
      resourceType: "script",
      url: "https://www.googletagmanager.com/gtm.js",
    });
    const image = fakeRoute({ resourceType: "image", url: "https://segment.com/logo.png" });

    for (const route of [navigation, ownScript, tagManager, image]) {
      await blocker(route as unknown as Route);
    }

    expect(navigation.continue).toHaveBeenCalled();
    expect(ownScript.continue).toHaveBeenCalled();
    expect(tagManager.abort).toHaveBeenCalled();
    expect(image.abort).toHaveBeenCalled();
  });

  it("createResourceBlocker() tracks the page URL of its own context only", async () => {
    const segmentPage = createResourceBlocker();
    const otherPage = createResourceBlocker();
    await segmentPage(
      fakeRoute({
        resourceType: "document",
        url: "https://segment.com/",
        navigation: true,
      }) as never,
    );
    await otherPage(
      fakeRoute({
        resourceType: "document",
        url: "https://example.com/",
        navigation: true,
      }) as never,
    );

    const script = fakeRoute({
      resourceType: "script",
      url: "https://cdn.segment.com/analytics.js",
    });
    await otherPage(script as unknown as Route);
    expect(script.abort).toHaveBeenCalled();
  });
});

describe("shouldBlockRequest() with the checked page URL", () => {
  it("does not block requests to the checked page's own vendor host (and its subdomains)", () => {
    const pageUrl = "https://segment.com/docs/connections/";
    expect(
      shouldBlockRequest({ ...request("script", "https://segment.com/app.js"), pageUrl }),
    ).toBe(false);
    expect(
      shouldBlockRequest({ ...request("xhr", "https://api.segment.com/v1/docs"), pageUrl }),
    ).toBe(false);
    expect(
      shouldBlockRequest({ ...request("script", "https://cdn.segment.com/x.js"), pageUrl }),
    ).toBe(false);
  });

  it("works when the page is on a subdomain of the vendor", () => {
    const pageUrl = "https://help.hotjar.com/hc/en-us";
    expect(
      shouldBlockRequest({
        ...request("script", "https://static.hotjar.com/c/hotjar.js"),
        pageUrl,
      }),
    ).toBe(false);
  });

  it("still blocks other vendors and heavy resource types on a vendor-hosted page", () => {
    const pageUrl = "https://segment.com/docs/";
    expect(
      shouldBlockRequest({
        ...request("script", "https://www.googletagmanager.com/gtm.js"),
        pageUrl,
      }),
    ).toBe(true);
    expect(
      shouldBlockRequest({ ...request("font", "https://segment.com/font.woff2"), pageUrl }),
    ).toBe(true);
  });

  it("blocks vendor hosts on regular pages", () => {
    const pageUrl = "https://docs.example.com/";
    expect(
      shouldBlockRequest({ ...request("script", "https://cdn.segment.com/x.js"), pageUrl }),
    ).toBe(true);
  });

  it("ignores an invalid page URL", () => {
    expect(
      shouldBlockRequest({ ...request("script", "https://cdn.segment.com/x.js"), pageUrl: "nope" }),
    ).toBe(true);
  });
});
