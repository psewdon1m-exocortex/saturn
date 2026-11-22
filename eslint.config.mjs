import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "artifacts/**",
      "tools/storage-spike/**",
      "tools/pnpm-runner/**",
      "eslint.config.mjs",
      "scripts/**/*.mjs",
      "!scripts/supervise-docker-cohort.mjs",
      "infra/production/*.mjs",
      "**/.tmp/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-confusing-void-expression": "off"
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "@typescript-eslint/require-await": "off"
    },
  },
  {
    files: ["apps/api/vitest.config.ts", "apps/web/src/*.js", "apps/web/integration/*.ts"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: [
      "packages/file-core/src/retention-clock.integration.mjs",
      "packages/protection/src/purge-clock.integration.mjs",
    ],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ["./tsconfig.eslint-clock.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["scripts/supervise-docker-cohort.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { parserOptions: { projectService: false } },
  },
);
