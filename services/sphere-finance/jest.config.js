/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  testRegex: "src/.*\\.spec\\.ts$",
  setupFiles: ["<rootDir>/test/env-setup.ts"],
  moduleNameMapper: {
    "^@noryx/db-core$": "<rootDir>/../../packages/db-core/src/index.ts",
    "^@noryx/shared-types$":
      "<rootDir>/../../packages/shared-types/src/index.ts",
  },
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.spec.ts", "!src/main.ts"],
};
