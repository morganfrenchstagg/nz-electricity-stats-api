import js from "@eslint/js";
import prettier from "eslint-config-prettier/flat";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores(["worker-configuration.d.ts", ".wrangler/"]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["*.config.mjs", "*.config.ts"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // a promise nobody awaits can be cut off when the Worker's request or cron run ends
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      // `any` is how the untyped JSON from EMI, em6 and POCP reaches its validators, and how
      // tests read response bodies; replacing it with `unknown` and type guards is its own change
      "@typescript-eslint/no-explicit-any": "off",
      // destructuring a field away (`const { id, ...rest } = row`) is how we omit one
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
    },
  },
  // formatting is Prettier's job, so turn off any rules that would fight it
  prettier,
);
