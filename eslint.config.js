// Foundation-owned. Flat config (ESLint 9). Appended to, never restructured.
//
// This file did not exist in the foundation commit and no track could create it:
// scripts/check-ownership.sh treats a new root file as out of bounds, so `npm run lint`
// was unsatisfiable for Tracks C and D by construction. That was a foundation bug, not
// a track failure. Added on main, 2 Aug 2026.

import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "**/*.d.ts",
      ".build/**",
      "mac/**",
      "intelligence/**",
    ],
  },
  {
    files: ["cloud/**/*.ts", "scripts/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: { project: false },
    },
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // The Channel interface is the seam between Tracks C and D. An `any` there
      // silently un-types the whole boundary, which is the one place types are
      // load-bearing across worktrees.
      "@typescript-eslint/no-explicit-any": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": "off",
    },
  },
  {
    files: ["**/*.test.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
];
