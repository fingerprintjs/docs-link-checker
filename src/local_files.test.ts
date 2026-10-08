// Skeleton: the titles of main's tests, to port with the new design (STEP 2, PIPELINE group).
import { describe, it } from "vitest";

describe("checkLocalLink()", () => {
  it.todo(
    "accepts existing files and directories (relative, root-relative, encoded, with a query string)",
  );
  it.todo("reports missing files as broken links, relative to the root");
  it.todo("checks anchors against headings of markdown files");
  it.todo("checks anchors on directories against their README");
  it.todo("checks GitHub line anchors on code files, ignores other anchors");
  it.todo("accepts accidental hashes and text fragments");
});
describe("checkLocalLink() outside the repository", () => {
  it.todo("rejects relative and root-relative links leaving the root, even to existing files");
  it.todo("accepts links to the root itself and inside it");
  it.todo("rejects symlinks inside the root that point outside, accepts symlinks within it");
});
describe("README of a directory anchor", () => {
  it.todo("finds README.markdown and lowercase or mixed-case names");
  it.todo("does not check the hash of a directory without a README");
  it.todo("prefers .md over .markdown and ignores directories named like a README");
  it.todo("picks README.md before readme.md, whatever the directory order");
});
describe("collectLinksFromFiles()", () => {
  it.todo("groups links by kind, with the file as page");
  it.todo("classifies hrefs and checks protocol-relative links over https");
  it.todo(
    "expands globs and file paths, sorted, deduplicated, markdown only, skipping node_modules",
  );
  it.todo("fails when no markdown file matches");
});
describe("checkLocalFiles()", () => {
  it.todo("checks local links on disk and includes the results of external links");
});
