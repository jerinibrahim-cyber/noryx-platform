import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { ThrottlerModule } from "@nestjs/throttler";
import { AuthCoreModule } from "@noryx/auth-core";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { TokenService } from "./token.service";
import { MfaService } from "./mfa.service";

@Module({
  imports: [
    // Milestone 3.2 Stage 1 — replaces the direct PassportModule import +
    // local JwtStrategy provider with the shared package
    // (docs/hardening/milestone-3.2-proposal.md §9 item 1). Behavior is
    // unchanged: AuthCoreModule registers the identical "jwt" Passport
    // strategy and re-exports PassportModule, exactly as this module did
    // inline before.
    AuthCoreModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),
    JwtModule.register({
      secret: process.env.JWT_ACCESS_SECRET,
      signOptions: { algorithm: "HS256" },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, TokenService, MfaService],
  exports: [JwtModule, TokenService],
})
export class AuthModule {}
