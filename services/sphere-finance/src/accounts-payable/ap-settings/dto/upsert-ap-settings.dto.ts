import { IsOptional, IsUUID } from "class-validator";

/// Single upsert DTO — POST /ap/settings both creates and updates the
/// one row for the caller's (tenantId, legalEntityId), per the proposal
/// (§16: "create/update (upsert)"). No separate PATCH endpoint.
export class UpsertApSettingsDto {
  @IsUUID()
  apControlAccountId!: string;

  @IsOptional()
  @IsUUID()
  taxInputAccountId?: string;
}
