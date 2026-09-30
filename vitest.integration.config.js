import { configDefaults, defineConfig } from "vitest/config";

// Integration tests (`pnpm test:integration`), they hit the network (websites, GitHub API) and need GH_TOKEN.
export default defineConfig({
  test: {
    testTimeout: 15000,
    include: ["**/*.integration.test.ts"],
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
});
