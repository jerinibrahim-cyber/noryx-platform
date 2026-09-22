import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAppRolePassword } from "../src/apply-app-role";

describe("AUD-010 Credential & Configuration Hygiene", () => {
  describe("Test A: Production credential enforcement", () => {
    it("rejects application-role bootstrap when NODE_ENV is production and APP_ROLE_PASSWORD is absent", () => {
      expect(() =>
        resolveAppRolePassword({
          NODE_ENV: "production",
          APP_ROLE_PASSWORD: "",
          APP_ROLE_DATABASE_URL: "",
        }),
      ).toThrow(
        "APP_ROLE_PASSWORD must be explicitly provided in production environments.",
      );
    });

    it("rejects application-role bootstrap when NODE_ENV is production and APP_ROLE_DATABASE_URL lacks password", () => {
      expect(() =>
        resolveAppRolePassword({
          NODE_ENV: "production",
          APP_ROLE_DATABASE_URL: "postgresql://noryx_app@localhost:5432/noryx",
        }),
      ).toThrow(
        "APP_ROLE_PASSWORD must be explicitly provided in production environments.",
      );
    });
  });

  describe("Test B: Explicit credential handling", () => {
    it("returns explicitly supplied APP_ROLE_PASSWORD in production", () => {
      const pwd = resolveAppRolePassword({
        NODE_ENV: "production",
        APP_ROLE_PASSWORD: "prod_secure_app_role_password_123!",
      });
      expect(pwd).toBe("prod_secure_app_role_password_123!");
    });

    it("extracts explicitly supplied password from APP_ROLE_DATABASE_URL in production", () => {
      const pwd = resolveAppRolePassword({
        NODE_ENV: "production",
        APP_ROLE_DATABASE_URL:
          "postgresql://noryx_app:extracted_secret_456@db.prod.internal:5432/noryx",
      });
      expect(pwd).toBe("extracted_secret_456");
    });

    it("uses development fixture default 'noryx_app' when NODE_ENV is not production and no credential is set", () => {
      const pwd = resolveAppRolePassword({
        NODE_ENV: "development",
      });
      expect(pwd).toBe("noryx_app");
    });
  });

  describe("Test C: SQL script credential safety", () => {
    it("verifies 001_create_app_role.sql contains no literal password and enforces session setting", () => {
      const sqlPath = join(
        __dirname,
        "..",
        "drizzle",
        "app-role",
        "001_create_app_role.sql",
      );
      const sql = readFileSync(sqlPath, "utf-8");

      // Verify no hardcoded password string literal
      expect(sql).not.toMatch(/PASSWORD\s+'(?!%L)/);
      expect(sql).not.toContain("PASSWORD 'noryx_app'");

      // Verify dynamic parameterization via PostgreSQL session configuration
      expect(sql).toContain("current_setting('noryx.app_role_password', true)");

      // Verify safety check that aborts if parameter is missing
      expect(sql).toContain("IF app_pwd IS NULL THEN");
      expect(sql).toContain("RAISE EXCEPTION");
    });
  });

  describe("Test D: Development Compose defaults", () => {
    it("verifies docker-compose.yml uses parameterized development fallbacks", () => {
      const composePath = join(
        __dirname,
        "..",
        "..",
        "..",
        "docker-compose.yml",
      );
      const compose = readFileSync(composePath, "utf-8");

      // Ensure credentials use environment variable substitution with defaults
      expect(compose).toContain("${POSTGRES_PASSWORD:-noryx_dev_only}");
      expect(compose).toContain("${APP_ROLE_PASSWORD:-noryx_app_dev_only}");
      expect(compose).toContain(
        "${JWT_ACCESS_SECRET:-local-dev-only-secret-do-not-use-in-production}",
      );
    });
  });
});
