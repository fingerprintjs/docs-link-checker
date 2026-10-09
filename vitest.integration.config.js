import { existsSync } from "node:fs";
import { configDefaults, defineConfig } from "vitest/config";

// Integration tests (`pnpm test:integration`), they hit the network (websites, GitHub API) and need GH_TOKEN.

// Optional local .env, the source code does not load it. Test workers inherit the env vars.
if (existsSync(".env")) {
  process.loadEnvFile();
}

export default defineConfig({
  test: {
    testTimeout: 15000,
    include: ["**/*.integration.test.ts"],
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
});
