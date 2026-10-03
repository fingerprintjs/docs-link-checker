/**
 * Runs exactly one benchmark round in its own process (see `bench/runner.ts`): checks the links of `<linksFile>`
 * with this tree's code, inside a fresh `withRun` (fresh caches, host limiter and browser), and writes the round
 * result (total time, run metrics, outcome per href) as JSON to `<outputFile>`.
 *
 * Only ever imports from `../src` (never from `./` or `node_modules` paths outside this file), so `--base <dir>`
 * can run the exact same script against another checkout: it is copied to `<dir>/.bench/round.ts` and run from
 * there with `cwd: dir`, so `../src` resolves to that checkout's own code and `node_modules`.
 *
 * Running base and head as separate processes (instead of two dynamic imports in one process) avoids one side's
 * module-level state (the shared page-slot semaphore in src/browser.ts, sitemap fetch limits...) leaking into the
 * other and biasing the comparison.
 *
 * Usage: tsx round.ts <linksFile> <outputFile>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { checkLinks } from "../src/link";
import { getRunContext, withRun } from "../src/run";
import type { Link, LinkWithResult } from "../src/types";

const outcomeOf = (link: LinkWithResult): string => (link.result.ok ? "ok" : link.result.error);

/** Structural check that `JSON.parse`d `value` is a `Link[]` (our own file, written by `bench/runner.ts`) */
const isLinkArray = (value: unknown): value is Link[] =>
  Array.isArray(value) &&
  value.every((item) => typeof item === "object" && item !== null && "href" in item);

const main = async () => {
  const [, , linksFile, outputFile] = process.argv;
  if (!linksFile || !outputFile) {
    throw new Error("Usage: tsx round.ts <linksFile> <outputFile>");
  }
  const parsed: unknown = JSON.parse(readFileSync(linksFile, "utf8"));
  if (!isLinkArray(parsed)) {
    throw new Error(`${linksFile} is not a valid links file.`);
  }
  const links = parsed;

  const start = performance.now();
  const { results, metrics } = await withRun({}, async () => {
    const roundResults = await checkLinks({ links });
    const context = getRunContext();
    if (!context) {
      throw new Error("No run context inside withRun, this should never happen.");
    }
    return { results: roundResults, metrics: context.metrics };
  });

  writeFileSync(
    outputFile,
    JSON.stringify({
      totalMs: performance.now() - start,
      metrics,
      outcomeByHref: results.map((link): [string, string] => [link.href, outcomeOf(link)]),
    }),
  );
};

await main();
