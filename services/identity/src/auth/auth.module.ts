import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { ThrottlerModule } from "@nestjs/throttler";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { TokenService } from "./token.service";
import { MfaService } from "./mfa.service";
import { JwtStrategy } from "./strategies/jwt.strategy";

@Module({
  imports: [
    PassportModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),
    JwtModule.register({
      secret: process.env.JWT_ACCESS_SECRET,
      signOptions: { algorithm: "HS256" },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, TokenService, MfaService, JwtStrategy],
  exports: [JwtModule, TokenService],
})
export class AuthModule {}
