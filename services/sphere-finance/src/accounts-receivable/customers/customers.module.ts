import { Module } from "@nestjs/common";
import { AuthCoreModule } from "@noryx/auth-core";
import { CustomersController } from "./customers.controller";
import { CustomersService } from "./customers.service";

@Module({
  imports: [AuthCoreModule],
  controllers: [CustomersController],
  providers: [CustomersService],
})
export class CustomersModule {}
