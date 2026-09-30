#!/usr/bin/env node
// Entry point of the `docs-link-checker` bin: runs the TypeScript CLI (src/cli.ts) with tsx, no build step needed.
import { register } from "tsx/esm/api";

register();
const { runCli } = await import("../src/cli.ts");
process.exitCode = await runCli(process.argv.slice(2));
