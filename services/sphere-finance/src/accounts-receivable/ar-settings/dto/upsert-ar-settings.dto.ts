import { IsOptional, IsUUID } from "class-validator";

/// Single upsert DTO — POST /ar/settings both creates and updates the one
/// row for the caller's (tenantId, legalEntityId), mirroring
/// UpsertApSettingsDto exactly. No separate PATCH endpoint.
export class UpsertArSettingsDto {
  @IsUUID()
  arControlAccountId!: string;

  @IsOptional()
  @IsUUID()
  taxOutputAccountId?: string;
}
