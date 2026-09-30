import { configDefaults, defineConfig } from "vitest/config";

// Offline unit tests (`pnpm test`), no network or GH_TOKEN needed.
// Network tests live in `*.integration.test.ts` files, see `vitest.integration.config.js`.
export default defineConfig({
  test: {
    testTimeout: 15000,
    exclude: [...configDefaults.exclude, "**/*.integration.test.ts", ".claude/**"],
    // Make sure unit tests never use a real token by accident, and never write to the job summary or the step
    // outputs of the CI run (GitHub Actions sets these for every step)
    env: { GH_TOKEN: "", GITHUB_STEP_SUMMARY: "", GITHUB_OUTPUT: "", GITHUB_ACTIONS: "" },
    unstubGlobals: true,
    unstubEnvs: true,
  },
});
