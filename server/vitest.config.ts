import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Full-match tests use the fast heuristic AI; search-v3 has its own tests.
    setupFiles: ["./tests/setup.ts"],
  },
});
