// Runs before the Jest test framework loads (see jest.config.js `setupFiles`)
// so module-level `process.env` reads (e.g. AuthModule's JwtModule.register)
// never see `undefined` during tests — mirrors what dotenv does at runtime,
// without needing a real .env file in CI.
process.env.JWT_ACCESS_SECRET ??=
  "test-only-secret-do-not-use-in-real-environments";
process.env.MFA_ENCRYPTION_KEY ??= "0".repeat(64);
process.env.DATABASE_URL ??=
  "postgresql://noryx:noryx@localhost:5432/noryx_test";
