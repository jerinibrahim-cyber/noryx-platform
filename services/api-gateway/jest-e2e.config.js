/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  testRegex: "test/.*\\.e2e-spec\\.ts$",
  moduleNameMapper: {
    "^@noryx/auth-core$": "<rootDir>/../../packages/auth-core/src/index.ts",
    "^@noryx/shared-types$":
      "<rootDir>/../../packages/shared-types/src/index.ts",
  },
};
