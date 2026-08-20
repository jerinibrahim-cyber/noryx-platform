import { Module } from "@nestjs/common";
import { FinanceAuthModule } from "../auth/finance-auth.module";
import { JournalEntriesController } from "./journal-entries.controller";
import { JournalEntriesService } from "./journal-entries.service";

@Module({
  imports: [FinanceAuthModule],
  controllers: [JournalEntriesController],
  providers: [JournalEntriesService],
})
export class JournalEntriesModule {}
