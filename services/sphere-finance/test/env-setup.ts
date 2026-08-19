// Runs before the Jest test framework loads (see jest.config.js/jest-e2e.config.js
// `setupFiles`) so module-level `process.env` reads (e.g. AppModule's
// JwtModule.register) never see `undefined` during tests — mirrors what
// dotenv does at runtime, without needing a real .env file in CI.
process.env.JWT_ACCESS_SECRET ??=
  "test-only-secret-do-not-use-in-real-environments";
process.env.DATABASE_URL ??=
  "postgresql://noryx:noryx@localhost:5432/noryx_test";
