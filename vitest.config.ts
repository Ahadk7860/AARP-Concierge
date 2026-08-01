import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["cloud/**/*.test.ts"],
    // Track C and Track D run concurrently in separate worktrees. Each uses its own
    // ports and database from CONTRACTS.md section 9; nothing here may hard-code a
    // default that both would pick.
    environment: "node",
  },
});
