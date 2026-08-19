/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  testRegex: "test/.*\\.e2e-spec\\.ts$",
  setupFiles: ["<rootDir>/test/env-setup.ts"],
  moduleNameMapper: {
    "^@noryx/db-core$": "<rootDir>/../../packages/db-core/src/index.ts",
    "^@noryx/shared-types$":
      "<rootDir>/../../packages/shared-types/src/index.ts",
  },
  // The RLS/audit-immutability e2e test performs several sequential
  // transactions against a real Postgres instance — give it more headroom
  // than jest's 5s default.
  testTimeout: 30000,
};
