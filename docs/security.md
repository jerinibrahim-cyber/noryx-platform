# Security & code integrity — what's enforced where

Condensed from the _Pre-Development Readiness Review_ §7. Full framework
and the compliance-mapping table (OWASP ASVS, Qatar PDPPL, ISO 27001,
SOC 2, PCI DSS, NIST CSF) live in that document.

| Control                                                 | Where it lives in this repo                                                                                                                        |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mandatory review, protected branches                    | `.github/CODEOWNERS` + branch protection settings (configured in repo settings, not in-repo)                                                       |
| Pre-commit secrets pre-filter                           | `.husky/pre-commit`                                                                                                                                |
| Secrets scan (full rule set)                            | `.github/workflows/ci.yml` → `secrets-scan` job (gitleaks)                                                                                         |
| SAST                                                    | `.github/workflows/ci.yml` → `sast` job (Semgrep: TypeScript, OWASP Top 10, nodejsscan rulesets)                                                   |
| SCA / dependency audit                                  | `.github/workflows/ci.yml` → `sca` job (`pnpm audit` + OSV-Scanner)                                                                                |
| IaC scanning                                            | `.github/workflows/ci.yml` → `iac-scan` job (Checkov against `infra/`)                                                                             |
| Container image scan                                    | `.github/workflows/ci.yml` → `docker-build-scan` job (Trivy)                                                                                       |
| Image signing + SBOM                                    | Same job — cosign (keyless/OIDC) + anchore/sbom-action                                                                                             |
| Tenant isolation (defense in depth)                     | `packages/db-core/drizzle/rls/001_enable_rls.sql` — Postgres Row-Level Security, `FORCE ROW LEVEL SECURITY`                                        |
| Immutable audit trail                                   | `packages/db-core/drizzle/rls/002_immutable_audit_log.sql` — a trigger rejects `UPDATE`/`DELETE` on `audit_logs` outright                          |
| MFA (TOTP)                                              | `services/identity/src/auth/mfa.service.ts` — secret encrypted at rest (AES-256-GCM) before it touches the DB                                      |
| Short-lived access tokens, opaque hashed refresh tokens | `services/identity/src/auth/token.service.ts`                                                                                                      |
| Account lockout                                         | `services/identity/src/auth/auth.service.ts` (5 failed attempts)                                                                                   |
| Rate limiting                                           | `@nestjs/throttler` in both `services/identity` and `services/api-gateway`                                                                         |
| Security headers (CSP, HSTS, etc.)                      | `helmet()` in both services' `main.ts`                                                                                                             |
| Input validation                                        | `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` in `services/identity/src/main.ts`; DTOs use `class-validator`                   |
| No secret in code/env files                             | `.env.example` files document variable names only; real values come from a secrets vault in staging/production (not yet provisioned — see roadmap) |

## Not yet implemented (tracked, not silently skipped)

- DAST against a running staging environment — no staging environment
  exists yet (Phase 0 is still local/CI-only).
- A managed secrets vault integration (Key Vault) — services currently
  read `process.env`, sourced from `.env` locally / CI secrets in
  pipelines; production wiring is a Phase 0 exit-criterion, not yet done.
- Third-party penetration test — scheduled before Phase 1 go-live per the
  Readiness Review, not applicable to an unreleased Phase 0 scaffold.
- ISO 27001 / SOC 2 gap assessment — Phase 2–3 per the Readiness Review's
  compliance-mapping table.
