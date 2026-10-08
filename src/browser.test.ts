// Skeleton: the titles of main's tests, to port with the new design (STEP 2, BROWSER group).
import { describe, it } from "vitest";

describe("shared browser", () => {
  it.todo("launches one browser for many Playwright checks and closes it at the end of checkLinks");
  it.todo("does not launch a browser when nothing needs Playwright");
  it.todo("shares a single launch between concurrent callers and limits open pages");
  it.todo("relaunches a crashed browser once and retries the check");
  it.todo("does not retry errors that are not crashes");
  it.todo("relaunches the browser when it crashes during navigation and retries the check");
  it.todo("reports navigation errors as broken links (no relaunch)");
  it.todo("reports browser launch failures as unexpected errors (not broken links)");
  it.todo("installs Chromium when the browser executable is missing and retries the launch");
  it.todo("reports a missing browser as an unexpected error when Chromium install fails");
});
describe("browser belongs to the run", () => {
  it.todo("closes the browser at the end of its own run, independently of other concurrent runs");
  it.todo("closes the run's browser even when the run fails, standalone checks are unaffected");
});
describe("request blocking", () => {
  it.todo("blocks images, media and fonts, keeps scripts, styles and data requests");
  it.todo("blocks analytics hosts and their subdomains, not look-alike hosts");
  it.todo("never blocks the checked link itself by type, but blocks analytics iframes");
  it.todo("does not block a vendor's own hosts when the checked page is hosted by it");
  it.todo("tracks the checked page per page and follows redirects of the main navigation");
  it.todo("does not throw on invalid request URLs");
  it.todo("ignores errors when the page is already closed");
});
