import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Single root Vitest pipeline for all workspace packages. Workspace sources
 * are TypeScript (no build step — Bun runs .ts directly), so packages are
 * aliased to their source entrypoints for tests.
 */

const src = (pkg: string): string => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "@harness/core", replacement: src("core") },
      { find: "@harness/tools", replacement: src("tools") },
      { find: "@harness/providers", replacement: src("providers") },
      { find: "@harness/cli", replacement: src("cli") },
      { find: "@harness/sdk", replacement: src("sdk") },
    ],
  },
  test: {
    include: ["packages/*/tests/**/*.test.ts", "packages/*/tests/**/*.test.tsx"],
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
