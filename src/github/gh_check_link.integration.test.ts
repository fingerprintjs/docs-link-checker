import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { runLive } from "../app";
import { checkLinkWithGithubApi } from "./gh_check_link";

// Live end-to-end smoke test per link type, needs `GH_TOKEN`. Routing, URL parsing and error mapping are covered by
// the unit tests. Each test is one run (the GitHub API responses are cached within it).
const REPO = "https://github.com/fingerprintjs/fingerprintjs";
// Content checks use a fixed commit: master changes
const SHA = "9a6c283cdeaee8905d5f085aef180c6ebbbf0e04";

const OK = { ok: true, status: 200 };
const BROKEN = { ok: false, error: "broken link", status: 404 };

describe("checkLinkWithGithubApi", () => {
  it("checks repositories", () =>
    runLive(
      Effect.gen(function* () {
        expect(yield* checkLinkWithGithubApi(REPO)).toMatchObject(OK);
        expect(yield* checkLinkWithGithubApi(`${REPO}-nonexistent`)).toMatchObject(BROKEN);
      }),
    ));

  it("checks users and organizations", () =>
    runLive(
      Effect.gen(function* () {
        expect(yield* checkLinkWithGithubApi("https://github.com/fingerprintjs")).toMatchObject(OK);
      }),
    ));

  it("checks issues", () =>
    runLive(
      Effect.gen(function* () {
        expect(yield* checkLinkWithGithubApi(`${REPO}/issues/1`)).toMatchObject(OK);
        expect(yield* checkLinkWithGithubApi(`${REPO}/issues/999999`)).toMatchObject({
          ...BROKEN,
          errorDetail: "Issue #999999 not found in repository fingerprintjs/fingerprintjs",
        });
      }),
    ));

  it("checks pull requests", () =>
    runLive(
      Effect.gen(function* () {
        expect(yield* checkLinkWithGithubApi(`${REPO}/pull/1094`)).toMatchObject(OK);
        expect(yield* checkLinkWithGithubApi(`${REPO}/pull/999999`)).toMatchObject(BROKEN);
      }),
    ));

  it("checks discussions", () =>
    runLive(
      Effect.gen(function* () {
        expect(yield* checkLinkWithGithubApi(`${REPO}/discussions/916`)).toMatchObject(OK);
        expect(yield* checkLinkWithGithubApi(`${REPO}/discussions/999999`)).toMatchObject(BROKEN);
      }),
    ));

  it("checks releases and release assets", () =>
    runLive(
      Effect.gen(function* () {
        expect(yield* checkLinkWithGithubApi(`${REPO}/releases/tag/v3.0.0`)).toMatchObject(OK);
        expect(yield* checkLinkWithGithubApi(`${REPO}/releases/tag/nonexistent-tag`)).toMatchObject(
          BROKEN,
        );
        expect(
          yield* checkLinkWithGithubApi(
            "https://github.com/fingerprintjs/fingerprintjs-android/releases/download/2.2.0/Playground-release-2.2.0.apk",
          ),
        ).toMatchObject(OK);
      }),
    ));

  it("checks commits", () =>
    runLive(
      Effect.gen(function* () {
        expect(
          yield* checkLinkWithGithubApi(
            "https://github.com/WebKit/WebKit/commit/6f2b47e87bc414001affb258048749130bc91083",
          ),
        ).toMatchObject(OK);
      }),
    ));

  it("checks files, headings and code lines", () =>
    runLive(
      Effect.gen(function* () {
        const readme = `${REPO}/blob/${SHA}/readme.md`;
        const packageJson = `${REPO}/blob/${SHA}/package.json`;

        expect(yield* checkLinkWithGithubApi(readme)).toMatchObject(OK);
        expect(yield* checkLinkWithGithubApi(`${readme}#demo`)).toMatchObject(OK);
        expect(yield* checkLinkWithGithubApi(`${readme}#nonexistent-heading`)).toMatchObject({
          ok: false,
          error: "hash not found",
          status: 200,
          errorDetail: "No heading found matching hash: nonexistent-heading",
        });
        expect(yield* checkLinkWithGithubApi(`${REPO}/blob/${SHA}/nonexistent.md`)).toMatchObject({
          ...BROKEN,
          errorDetail: "File not found in repository",
        });
        expect(yield* checkLinkWithGithubApi(`${packageJson}#L5-L10`)).toMatchObject(OK);
        expect(yield* checkLinkWithGithubApi(`${packageJson}#L8888-L9999`)).toMatchObject({
          ok: false,
          error: "hash not found",
          errorDetail: expect.stringMatching(/^package\.json has only \d+ lines$/),
        });
      }),
    ));

  it("checks files at a branch", () =>
    runLive(
      Effect.gen(function* () {
        expect(yield* checkLinkWithGithubApi(`${REPO}/blob/master/readme.md`)).toMatchObject(OK);
      }),
    ));

  it("checks branches, commits and folders", () =>
    runLive(
      Effect.gen(function* () {
        expect(yield* checkLinkWithGithubApi(`${REPO}/tree/master`)).toMatchObject(OK);
        expect(yield* checkLinkWithGithubApi(`${REPO}/tree/nonexistent-branch`)).toMatchObject(
          BROKEN,
        );
        expect(yield* checkLinkWithGithubApi(`${REPO}/tree/${SHA}/src`)).toMatchObject(OK);
        expect(yield* checkLinkWithGithubApi(`${REPO}/tree/${SHA}/nonexistent`)).toMatchObject(
          BROKEN,
        );
      }),
    ));
});
