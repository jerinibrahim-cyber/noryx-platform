/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
  moduleNameMapper: {
    "^@noryx/shared-types$": "<rootDir>/../shared-types/src/index.ts",
  },
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.test.ts"],
};
