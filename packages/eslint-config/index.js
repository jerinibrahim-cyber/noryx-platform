// Shared flat ESLint config for every Noryx service/app/package.
// `eslint-plugin-security` catches the classic injection/unsafe-regex/
// child-process footguns as a pipeline gate (Pre-Development Readiness
// Review §7.2 — SAST) rather than relying on review discipline alone.
const tsParser = require("@typescript-eslint/parser");
const tsPlugin = require("@typescript-eslint/eslint-plugin");
const securityPlugin = require("eslint-plugin-security");
const prettierConfig = require("eslint-config-prettier");

module.exports = [
  {
    ignores: [
      "dist/**",
      "build/**",
      "coverage/**",
      "node_modules/**",
      "**/*.js",
    ],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      security: securityPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...securityPlugin.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "security/detect-object-injection": "off",
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  prettierConfig,
];
