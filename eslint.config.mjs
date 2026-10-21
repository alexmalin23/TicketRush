// @ts-check
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["dist/", "coverage/", "node_modules/", "load/results/"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      // `_name` marks a value that is unused on purpose (e.g. omitting a field from an object).
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // `new (...args: any[]) => T` is the type of "any class": the DI container must call
    // constructors with arbitrary signatures, and `unknown[]` would reject most classes.
    files: ["src/core/types.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    // CommonJS config files at the repo root (jest.config.js).
    files: ["*.js"],
    languageOptions: { sourceType: "commonjs", globals: { module: "writable", require: "readonly" } },
  },
  {
    // k6 scenarios run in k6's own JS runtime, which provides these globals.
    files: ["load/**/*.js"],
    languageOptions: { globals: { __ENV: "readonly", __VU: "readonly", __ITER: "readonly" } },
  }
);
