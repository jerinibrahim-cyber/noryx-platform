/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  testRegex: "test/.*\\.e2e-spec\\.ts$",
  setupFiles: ["<rootDir>/test/env-setup.ts"],
  // These tests open several sequential raw Postgres connections/
  // transactions (owner role, then noryx_app) — give more headroom than
  // jest's 5s default, same reasoning as sphere-finance's e2e config.
  testTimeout: 30000,
};
