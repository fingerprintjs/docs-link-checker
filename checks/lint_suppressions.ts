// Fails when lint or type check suppressions are added without a reason, or above the budget.
// Every suppression hides a finding from review, so adding one should be a visible decision (raise the budget below).
import { readFileSync } from "node:fs";
import { glob } from "node:fs/promises";

/** Maximum number of suppressions in the codebase */
const MAX_SUPPRESSIONS = 4;

const SOURCE_FILES = ["src/**/*.{ts,tsx}", "checks/**/*.ts", "bin/**/*.js", "*.config.js"];
const IGNORED_DIRECTORIES = new Set(["node_modules", "__fixtures__"]);

// `@ts-ignore` and `@ts-nocheck` are banned by oxlint (`typescript/ban-ts-comment`), listed here to count them anyway
const SUPPRESSION =
  /(?:\/\/|\/\*)\s*(?:(?:oxlint|eslint)-disable|@ts-(?:ignore|nocheck|expect-error))/;
// `oxlint-disable-next-line rule -- reason`, `@ts-expect-error reason`
const HAS_REASON = /(?:-disable[\w-]*\s+\S+.*\s--\s+\S|@ts-expect-error\s+\S)/;

type Suppression = { location: string; text: string };

const findSuppressions = async (): Promise<Suppression[]> => {
  const found: Suppression[] = [];
  for await (const file of glob(SOURCE_FILES, {
    exclude: (path) => IGNORED_DIRECTORIES.has(path.split("/").at(-1) ?? ""),
  })) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (SUPPRESSION.test(line)) {
          found.push({ location: `${file}:${index + 1}`, text: line.trim() });
        }
      });
  }
  return found;
};

const suppressions = await findSuppressions();
const withoutReason = suppressions.filter(({ text }) => !HAS_REASON.test(text));

for (const { location, text } of withoutReason) {
  console.error(`${location}: suppression without a reason (add "-- reason"): ${text}`);
}
if (suppressions.length > MAX_SUPPRESSIONS) {
  console.error(
    `${suppressions.length} suppressions, the budget is ${MAX_SUPPRESSIONS}. Fix the findings instead, ` +
      `or raise MAX_SUPPRESSIONS in checks/lint_suppressions.ts if a suppression is really needed:`,
  );
  for (const { location, text } of suppressions) {
    console.error(`  ${location}: ${text}`);
  }
}
if (withoutReason.length > 0 || suppressions.length > MAX_SUPPRESSIONS) {
  process.exitCode = 1;
} else {
  console.log(
    `${suppressions.length} suppressions (budget ${MAX_SUPPRESSIONS}), all with a reason.`,
  );
}
