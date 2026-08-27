import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  MaxLength,
} from "class-validator";

/**
 * docs/finance-work-item-banking-1b-proposal.md §14, §19 item 4. All
 * fields optional — a PATCH only touches what it sends, same convention
 * as UpdateSupplierPaymentDto. Only permitted while the Bank Transaction
 * is still DRAFT (enforced in the service, same as every other document's
 * edit path). `bankCashAccountId` IS editable here (same posture as
 * UpdateSupplierPaymentDto allowing its own `bankCashAccountId` to
 * change) — re-validated identically to create time.
 *
 * `type` is deliberately absent and therefore immutable post-creation
 * (locked CTO decision, proposal §19 item 4) — mirrors how no existing
 * document type allows changing its own fundamental "kind" mid-DRAFT; to
 * change type, delete and recreate the DRAFT (cheap, since nothing has
 * posted yet).
 *
 * Because `type` is not part of this payload, the create DTO's single
 * `IsValidBankTransactionAccountShape` constraint (anchored on `type`)
 * cannot apply here. The service enforces the identical shape instead,
 * evaluated against the transaction's own existing (immutable) `type`: a
 * TRANSFER's update may only set `counterpartyBankCashAccountId` (setting
 * `glAccountId` is rejected); every other type's update may only set
 * `glAccountId` (setting `counterpartyBankCashAccountId` is rejected).
 */
export class UpdateBankTransactionDto {
  @IsOptional()
  @IsDateString()
  transactionDate?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  amountMinor?: number;

  @IsOptional()
  @IsUUID()
  bankCashAccountId?: string;

  @IsOptional()
  @IsUUID()
  counterpartyBankCashAccountId?: string;

  @IsOptional()
  @IsUUID()
  glAccountId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  reference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  memo?: string;
}
