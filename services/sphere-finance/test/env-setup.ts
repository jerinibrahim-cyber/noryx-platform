// Runs before the Jest test framework loads (see jest.config.js/jest-e2e.config.js
// `setupFiles`) so module-level `process.env` reads (e.g. AppModule's
// JwtModule.register) never see `undefined` during tests — mirrors what
// dotenv does at runtime, without needing a real .env file in CI.
//
// reflect-metadata must load before any decorated class is imported —
// required by class-transformer's @Type() (used by DTOs with nested
// validation, e.g. CreateJournalEntryDto's `lines` array) and by Nest's
// own decorators generally (main.ts imports it first for the same
// reason). Belongs here, not in individual spec files, so every unit
// test gets it regardless of which DTO it happens to import first.
import "reflect-metadata";

process.env.JWT_ACCESS_SECRET ??=
  "test-only-secret-do-not-use-in-real-environments";
process.env.DATABASE_URL ??=
  "postgresql://noryx:noryx@localhost:5432/noryx_test";
