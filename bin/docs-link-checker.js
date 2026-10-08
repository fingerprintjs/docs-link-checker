#!/usr/bin/env node
// Entry point of the `docs-link-checker` bin: runs the TypeScript CLI (src/cli.ts) with tsx, no build step needed.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";

register({ tsconfig: join(dirname(fileURLToPath(import.meta.url)), "..", "tsconfig.json") });
const { runCli } = await import("../src/cli.ts");
process.exitCode = await runCli(process.argv.slice(2));
