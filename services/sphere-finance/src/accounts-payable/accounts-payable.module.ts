import { Module } from "@nestjs/common";
import { SuppliersModule } from "./suppliers/suppliers.module";
import { ApSettingsModule } from "./ap-settings/ap-settings.module";

/**
 * AP Foundation's parent module. AP-1a wires exactly the two feature
 * modules below (Supplier Master + AP Settings) — docs/finance-work-item-1
 * -ap-foundation-proposal.md §22's remaining sub-increments (AP-1b
 * Supplier Bills, AP-1c Supplier Payments + Allocations, AP-1d AP
 * Reporting) each add their own feature module as a sibling import here
 * when their own review checkpoint is reached. Not implemented yet — do
 * not add placeholder modules for them ahead of that.
 */
@Module({
  imports: [SuppliersModule, ApSettingsModule],
})
export class AccountsPayableModule {}
