import { Module } from "@nestjs/common";
import { AuthCoreModule } from "@noryx/auth-core";
import { ApSettingsController } from "./ap-settings.controller";
import { ApSettingsService } from "./ap-settings.service";

@Module({
  imports: [AuthCoreModule],
  controllers: [ApSettingsController],
  providers: [ApSettingsService],
})
export class ApSettingsModule {}
