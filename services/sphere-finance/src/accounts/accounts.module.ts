import { Module } from "@nestjs/common";
import { PassportModule } from "@nestjs/passport";
import { AccountsController } from "./accounts.controller";
import { AccountsService } from "./accounts.service";
import { JwtStrategy } from "../auth/strategies/jwt.strategy";

@Module({
  imports: [PassportModule],
  controllers: [AccountsController],
  providers: [AccountsService, JwtStrategy],
})
export class AccountsModule {}
