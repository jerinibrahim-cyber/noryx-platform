import { Module } from "@nestjs/common";
import { PassportModule } from "@nestjs/passport";
import { JwtStrategy } from "./strategies/jwt.strategy";

/**
 * Milestone 3.2 Stage 1 — shared auth wiring for any Nest module that
 * needs JwtAuthGuard/RolesGuard to work (i.e. needs the "jwt" Passport
 * strategy registered somewhere in the application). Mirrors the exact
 * shape of services/sphere-finance's former FinanceAuthModule
 * (`{ imports: [PassportModule], providers: [JwtStrategy], exports:
 * [PassportModule] }`), generalized so every consuming service — Identity,
 * Finance, API Gateway, and any future service — imports this one module
 * instead of each registering its own PassportModule + JwtStrategy pair.
 */
@Module({
  imports: [PassportModule],
  providers: [JwtStrategy],
  exports: [PassportModule],
})
export class AuthCoreModule {}
