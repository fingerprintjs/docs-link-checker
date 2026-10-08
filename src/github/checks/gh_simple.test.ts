import { beforeEach, describe, expect, it, vi } from "vitest";

const { octokit } = vi.hoisted(() => ({ octokit: { graphql: vi.fn() } }));

vi.mock("../github_client", () => ({ getMyOctokit: () => octokit }));

import { checkLinkWithGithubApi } from "../gh_check_link";

// GraphQL answers a missing repository or discussion with errors in a 200 response
const graphqlError = (message: string, type?: string) =>
  Object.assign(new Error(message), { errors: [{ type, message }] });

beforeEach(() => {
  octokit.graphql.mockReset();
});

describe("checkLinkWithGithubApi() with discussion links", () => {
  it("is OK for an existing discussion", async () => {
    octokit.graphql.mockResolvedValue({ repository: { discussion: { id: "D_1" } } });
    expect(await checkLinkWithGithubApi("https://github.com/owner/repo/discussions/1")).toEqual({
      ok: true,
      status: 200,
    });
  });

  it.each([
    [
      "missing discussion",
      graphqlError("Could not resolve to a Discussion with the number of 9.", "NOT_FOUND"),
    ],
    [
      "missing repository",
      graphqlError("Could not resolve to a Repository with the name 'owner/x'.", "NOT_FOUND"),
    ],
    ["NOT_FOUND type only", graphqlError("Something else", "NOT_FOUND")],
    [
      "message only",
      Object.assign(new Error("Could not resolve to a Repository with the name 'a/b'."), {}),
    ],
  ])("is a broken link for a %s", async (_, error) => {
    octokit.graphql.mockRejectedValue(error);
    expect(
      await checkLinkWithGithubApi("https://github.com/owner/repo/discussions/9"),
    ).toMatchObject({
      ok: false,
      error: "broken link",
      status: 404,
    });
  });

  it.each([
    ["rate limit (403)", Object.assign(new Error("API rate limit exceeded"), { status: 403 })],
    ["bad credentials (401)", Object.assign(new Error("Bad credentials"), { status: 401 })],
    ["server error (502)", Object.assign(new Error("Bad Gateway"), { status: 502 })],
    ["other GraphQL error", graphqlError("Something went wrong", "INTERNAL")],
  ])("is an unexpected error for a %s", async (_, error) => {
    octokit.graphql.mockRejectedValue(error);
    expect(
      await checkLinkWithGithubApi("https://github.com/owner/repo/discussions/1"),
    ).toMatchObject({
      ok: false,
      error: "unexpected error",
    });
  });
});
