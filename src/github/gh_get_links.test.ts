import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { octokit, checkGitHubRateLimit } = vi.hoisted(() => ({
  octokit: {
    paginate: vi.fn(),
    repos: { listForOrg: {}, get: vi.fn() },
    git: { getTree: vi.fn() },
  },
  checkGitHubRateLimit: vi.fn(),
}));

vi.mock("./github_client", () => ({
  getMyOctokit: () => octokit,
  checkGitHubRateLimit,
}));

import { HostLimiter } from "../limiter";
import { setHostLimiter } from "../run";
import { checkReadmesInGithubOrg, getReadmeLinks, getReadmesFromOrg } from "./gh_get_links";

const repos = ["repo-c", "repo-a", "repo-b", "repo-d"].map((name) => ({
  full_name: `org/${name}`,
  owner: { login: "org" },
  name,
  archived: false,
}));

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  octokit.paginate.mockReset().mockResolvedValue(repos);
  octokit.repos.get.mockReset().mockResolvedValue({ data: { default_branch: "main" } });
  octokit.git.getTree.mockReset().mockResolvedValue({
    data: {
      tree: [
        { type: "blob", path: "README.md" },
        { type: "blob", path: "docs/readme.md" },
        { type: "blob", path: "index.ts" },
      ],
    },
  });
  checkGitHubRateLimit.mockReset().mockResolvedValue({ remaining: 5000 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getReadmesFromOrg()", () => {
  it("lists README files of all repositories", async () => {
    const readmes = await getReadmesFromOrg("org");
    expect(readmes).toHaveLength(8);
    expect(readmes).toContainEqual({
      sourcePath: "https://github.com/org/repo-a/blob/main/docs/readme.md",
      downloadUrl: "https://raw.githubusercontent.com/org/repo-a/main/docs/readme.md",
    });
  });

  it("throws a clear error when the repositories cannot be listed", async () => {
    octokit.paginate.mockRejectedValue(new Error("Bad credentials"));
    await expect(getReadmesFromOrg("org")).rejects.toThrow(
      "Failed to list repositories of GitHub organization org: Bad credentials",
    );
  });

  it("samples README files deterministically with LINK_CHECK_SAMPLE_RATE", async () => {
    vi.stubEnv("LINK_CHECK_SAMPLE_RATE", "0.25");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const first = await getReadmesFromOrg("org");
    octokit.paginate.mockResolvedValue(repos.toReversed());
    const second = await getReadmesFromOrg("org");

    expect(first).toHaveLength(2);
    expect(second).toEqual(first);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Sampling 2 of 8 README files"));
  });
});

describe("checkReadmesInGithubOrg()", () => {
  it("waits for the rate limit check and fails when it fails", async () => {
    checkGitHubRateLimit.mockRejectedValue(new Error("Bad credentials"));
    await expect(checkReadmesInGithubOrg("org")).rejects.toThrow("Bad credentials");
    expect(octokit.paginate).not.toHaveBeenCalled();
  });

  it("fails with a clear error (instead of crashing on undefined) when listing READMEs fails", async () => {
    octokit.paginate.mockRejectedValue(new Error("Not Found"));
    await expect(checkReadmesInGithubOrg("org")).rejects.toThrow(
      "Failed to list repositories of GitHub organization org: Not Found",
    );
  });
});

describe("getReadmeLinks()", () => {
  afterEach(() => {
    setHostLimiter(undefined);
  });

  it("downloads README files within the per-host limit and retries after a 429", async () => {
    setHostLimiter(new HostLimiter(3));
    let active = 0;
    let maxActive = 0;
    const rateLimited = new Set<string>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        // The first download of file 0 is rate limited
        if (url.endsWith("/0/README.md") && !rateLimited.has(url)) {
          rateLimited.add(url);
          return new Response(null, { status: 429, headers: { "Retry-After": "0" } });
        }
        return new Response("[link](https://example.com/)", { status: 200 });
      }),
    );
    const files = Array.from({ length: 20 }, (_, i) => ({
      sourcePath: `https://github.com/org/repo/blob/main/${i}/README.md`,
      downloadUrl: `https://raw.githubusercontent.com/org/repo/main/${i}/README.md`,
    }));

    const links = await getReadmeLinks(files);

    expect(maxActive).toBe(3);
    expect(links).toHaveLength(20);
    expect(rateLimited.size).toBe(1);
  });
});
