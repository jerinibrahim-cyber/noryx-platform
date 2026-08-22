// Runs before Jest loads, same reasoning as identity's/sphere-finance's
// test/env-setup.ts: module-level process.env reads never see undefined
// during tests, without needing a real .env file in CI.
//
// Two connection strings, deliberately different roles:
// - DATABASE_URL: the migration/schema-owner role (`noryx` in this repo's
//   dev/CI setup) — used to seed fixture data.
// - APP_ROLE_DATABASE_URL: the dedicated least-privilege role
//   (`noryx_app`, Milestone 3.1 §2.1) — used by the direct-RLS-proof test
//   to connect exactly as the running application does, independent of
//   any service/ORM code.
process.env.DATABASE_URL ??=
  "postgresql://noryx:noryx@localhost:5432/noryx_test";
process.env.APP_ROLE_DATABASE_URL ??=
  "postgresql://noryx_app:noryx_app@localhost:5432/noryx_test";
