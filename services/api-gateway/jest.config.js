/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  testRegex: "src/.*\\.spec\\.ts$",
  moduleNameMapper: {
    "^@noryx/shared-types$":
      "<rootDir>/../../packages/shared-types/src/index.ts",
  },
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.spec.ts", "!src/main.ts"],
};
