// Skeleton: the titles of main's tests, to port with the new design (STEP 2, PIPELINE group).
import { describe, it } from "vitest";

describe("each checker (fetch and Playwright)", () => {
  it.todo(`should return OK for working links`);
  it.todo(`should return broken link for 404 links`);
  it.todo(`should return OK for hashes that exist (server-rendered)`);
  it.todo(`should return 'hash not found' for broken hash links (server-rendered)`);
  it.todo(`should return OK for hashes implemented using 'href', like on GitHub`);
  it.todo(
    `should return OK for hashes implemented using 'href', like on GitHub, even despite different casing`,
  );
});
describe("checkLinkWithPlaywright()", () => {
  it.todo("should return OK for hashes that exist (client-rendered)");
  it.todo("should return 'hash not found' for broken hash links (client-rendered)");
  it.todo(
    "should return OK for anchors rendered late (Mintlify expands nested fields on hash navigation)",
  );
});
describe("checkLinks() GitHub code line links", () => {
  it.todo("checks the lines against the file from the GitHub API, without a browser navigation");
});
