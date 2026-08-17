/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  testRegex: "test/.*\\.e2e-spec\\.ts$",
  moduleNameMapper: {
    "^@noryx/shared-types$":
      "<rootDir>/../../packages/shared-types/src/index.ts",
  },
};
