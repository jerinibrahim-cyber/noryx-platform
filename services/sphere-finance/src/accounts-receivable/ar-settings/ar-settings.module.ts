import { Module } from "@nestjs/common";
import { AuthCoreModule } from "@noryx/auth-core";
import { ArSettingsController } from "./ar-settings.controller";
import { ArSettingsService } from "./ar-settings.service";

@Module({
  imports: [AuthCoreModule],
  controllers: [ArSettingsController],
  providers: [ArSettingsService],
})
export class ArSettingsModule {}
