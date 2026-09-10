import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, auditLogs } from "@noryx/db-core";
import { taxCodes, type TaxCode } from "../db/schema";
import { withTenant, type TxClient } from "../db/db";
import type { CreateTaxCodeDto } from "./dto/create-tax-code.dto";

/**
 * Tax Code master data — Tax / VAT MVP Phase 1 (CTO-approved
 * architecture proposal §3/§7, CTO decision turn). Same
 * RLS(via withTenant)/legal-entity-predicate/audit conventions as
 * SuppliersService — see that file's doc comment for the reasoning,
 * unchanged here. No hard delete: deactivate()/reactivate() only,
 * identical shape to SuppliersService.setActive().
 */
@Injectable()
export class TaxCodesService {
  async create(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    dto: CreateTaxCodeDto,
  ): Promise<TaxCode> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const existing = await tx
        .select()
        .from(taxCodes)
        .where(
          and(
            eq(taxCodes.legalEntityId, legalEntityId),
            eq(taxCodes.code, dto.code),
          ),
        )
        .limit(1);
      if (existing.length > 0) {
        throw new ConflictException(
          `A tax code with code "${dto.code}" already exists in this legal entity.`,
        );
      }

      const [created] = await tx
        .insert(taxCodes)
        .values({
          tenantId,
          legalEntityId,
          code: dto.code,
          name: dto.name,
          treatment: dto.treatment,
          createdBy: actorUserId ?? null,
        })
        .returning();

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "CREATE",
        entityType: "tax_code",
        entityId: created!.id,
        beforeState: null,
        afterState: created as unknown as Record<string, unknown>,
      });

      return created!;
    });
  }

  async list(
    tenantId: string,
    legalEntityId: string,
    includeInactive: boolean,
  ): Promise<TaxCode[]> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const scope = eq(taxCodes.legalEntityId, legalEntityId);
      if (includeInactive) {
        return tx.select().from(taxCodes).where(scope);
      }
      return tx
        .select()
        .from(taxCodes)
        .where(and(scope, eq(taxCodes.isActive, true)));
    });
  }

  async findOne(
    tenantId: string,
    legalEntityId: string,
    id: string,
  ): Promise<TaxCode> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const taxCode = await this.findByIdInTx(tx, legalEntityId, id);
      if (!taxCode) {
        throw new NotFoundException(`No tax code found with id ${id}.`);
      }
      return taxCode;
    });
  }

  async deactivate(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
  ): Promise<TaxCode> {
    return this.setActive(
      tenantId,
      legalEntityId,
      actorUserId,
      id,
      false,
      "DEACTIVATE",
    );
  }

  async reactivate(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
  ): Promise<TaxCode> {
    return this.setActive(
      tenantId,
      legalEntityId,
      actorUserId,
      id,
      true,
      "REACTIVATE",
    );
  }

  /** Shared by deactivate()/reactivate() — idempotent, same posture as
   * SuppliersService.setActive() (no 409 on a no-op transition; the
   * audit trail still records the action). Deactivating a tax code does
   * NOT retroactively affect any document already referencing it —
   * Phase 1 implements no such reference yet (Phase 2/3), so this is a
   * forward-compatibility note, not enforced behavior in this phase. */
  async findByIdInTx(
    tx: TxClient,
    legalEntityId: string,
    id: string,
  ): Promise<TaxCode | undefined> {
    const rows = await tx
      .select()
      .from(taxCodes)
      .where(
        and(eq(taxCodes.id, id), eq(taxCodes.legalEntityId, legalEntityId)),
      )
      .limit(1);
    return rows[0];
  }

  private async setActive(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    id: string,
    isActive: boolean,
    action: "DEACTIVATE" | "REACTIVATE",
  ): Promise<TaxCode> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const before = await this.findByIdInTx(tx, legalEntityId, id);
      if (!before) {
        throw new NotFoundException(`No tax code found with id ${id}.`);
      }

      const [updated] = await tx
        .update(taxCodes)
        .set({ isActive, updatedAt: new Date() })
        .where(
          and(eq(taxCodes.id, id), eq(taxCodes.legalEntityId, legalEntityId)),
        )
        .returning();

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action,
        entityType: "tax_code",
        entityId: id,
        beforeState: before as unknown as Record<string, unknown>,
        afterState: updated as unknown as Record<string, unknown>,
      });

      return updated!;
    });
  }
}
