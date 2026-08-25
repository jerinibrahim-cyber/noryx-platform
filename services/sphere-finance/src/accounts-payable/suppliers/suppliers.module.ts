import { Module } from "@nestjs/common";
import { AuthCoreModule } from "@noryx/auth-core";
import { SuppliersController } from "./suppliers.controller";
import { SuppliersService } from "./suppliers.service";

@Module({
  imports: [AuthCoreModule],
  controllers: [SuppliersController],
  providers: [SuppliersService],
})
export class SuppliersModule {}
