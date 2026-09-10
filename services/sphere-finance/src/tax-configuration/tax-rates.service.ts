import {
  BadRequestException,
  ConflictException,
  Injectable,
} from "@nestjs/common";
import { and, auditLogs, eq, gte, isNull, lte, or } from "@noryx/db-core";
import { PostgresError } from "postgres";
import { taxRates, type TaxRate } from "../db/schema";
import { withTenant, type TxClient } from "../db/db";
import { TaxCodesService } from "./tax-codes.service";
import type { CreateTaxRateDto } from "./dto/create-tax-rate.dto";

/**
 * Tax Rate — Tax / VAT MVP Phase 1 (CTO-approved architecture proposal
 * §3/§7, CTO decision turn, Decision 6). Create-only — no update/delete
 * route exists at all, so no immutability trigger is required the way
 * posted-document tables need one; the absence of a mutating route IS
 * the enforcement (same posture accounting_periods takes for "no
 * reopen").
 *
 * Overlap handling follows AccountingPeriodsService.create()'s exact
 * two-layer shape verbatim: a friendly pre-check (better error message
 * when there's no race) plus a try/catch around the INSERT that closes
 * the real race via the DB's own EXCLUDE USING gist constraint
 * (025_tax_rates_no_overlap_exclusion.sql) — the pre-check alone cannot
 * close a race between two concurrent creates.
 */
@Injectable()
export class TaxRatesService {
  constructor(private readonly taxCodes: TaxCodesService) {}

  async create(
    tenantId: string,
    legalEntityId: string,
    actorUserId: string | null,
    taxCodeId: string,
    dto: CreateTaxRateDto,
  ): Promise<TaxRate> {
    return withTenant(tenantId, async (tx: TxClient) => {
      // taxCodeId must exist and belong to this legal entity — RLS
      // already scopes the lookup to the caller's tenant; this adds the
      // explicit legal-entity predicate, same as every cross-reference
      // in this codebase (e.g. ApSettingsService.validateTaxAccountOrThrow).
      const taxCode = await this.taxCodes.findByIdInTx(
        tx,
        legalEntityId,
        taxCodeId,
      );
      if (!taxCode) {
        throw new BadRequestException(
          `taxCodeId ${taxCodeId} does not refer to a tax code in this legal entity.`,
        );
      }

      // Friendly pre-check — better error message when there's no race.
      // The real guarantee is the EXCLUDE USING gist constraint; the
      // catch block below is what closes the race this pre-check can't
      // (identical reasoning to AccountingPeriodsService.create()).
      const overlapping = await tx
        .select()
        .from(taxRates)
        .where(
          and(
            eq(taxRates.tenantId, tenantId),
            eq(taxRates.legalEntityId, legalEntityId),
            eq(taxRates.taxCodeId, taxCodeId),
            lte(taxRates.effectiveFrom, dto.effectiveTo ?? "9999-12-31"),
            or(
              isNull(taxRates.effectiveTo),
              gte(taxRates.effectiveTo, dto.effectiveFrom),
            ),
          ),
        )
        .limit(1);
      if (overlapping.length > 0) {
        throw new ConflictException(
          `This rate's date range overlaps an existing rate for tax code "${taxCode.code}".`,
        );
      }

      let created: TaxRate;
      try {
        const [row] = await tx
          .insert(taxRates)
          .values({
            tenantId,
            legalEntityId,
            taxCodeId,
            rateBasisPoints: dto.rateBasisPoints,
            effectiveFrom: dto.effectiveFrom,
            effectiveTo: dto.effectiveTo ?? null,
            createdBy: actorUserId ?? null,
          })
          .returning();
        created = row!;
      } catch (err) {
        // Closes the race the pre-check above can't: two concurrent
        // create() calls both pass the pre-check, both attempt the
        // insert, one commits, the loser lands here. No raw Postgres
        // error may escape the API — 23P01 is the EXCLUDE USING gist
        // overlap constraint, 23514 is a CHECK constraint (rate
        // non-negative / end-after-start) violation that slipped past
        // DTO validation.
        if (
          err instanceof PostgresError &&
          (err.code === "23P01" || err.code === "23514")
        ) {
          throw new ConflictException(
            `This rate's date range conflicts with an existing rate for tax code "${taxCode.code}".`,
          );
        }
        throw err;
      }

      await tx.insert(auditLogs).values({
        tenantId,
        legalEntityId,
        actorUserId: actorUserId ?? undefined,
        action: "CREATE",
        entityType: "tax_rate",
        entityId: created.id,
        beforeState: null,
        afterState: created as unknown as Record<string, unknown>,
      });

      return created;
    });
  }

  async list(
    tenantId: string,
    legalEntityId: string,
    taxCodeId: string,
  ): Promise<TaxRate[]> {
    return withTenant(tenantId, async (tx: TxClient) => {
      const taxCode = await this.taxCodes.findByIdInTx(
        tx,
        legalEntityId,
        taxCodeId,
      );
      if (!taxCode) {
        throw new BadRequestException(
          `taxCodeId ${taxCodeId} does not refer to a tax code in this legal entity.`,
        );
      }
      return tx
        .select()
        .from(taxRates)
        .where(
          and(
            eq(taxRates.legalEntityId, legalEntityId),
            eq(taxRates.taxCodeId, taxCodeId),
          ),
        )
        .orderBy(taxRates.effectiveFrom);
    });
  }
}
