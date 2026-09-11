import {
  BadRequestException,
  ConflictException,
  Injectable,
} from "@nestjs/common";
import { and, auditLogs, eq, gt, isNull, lt, lte, or } from "@noryx/db-core";
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
      //
      // Tax/VAT Phase 2 correction (discovered while testing
      // resolveEffectiveRate()'s half-open boundary, docs/finance-
      // work-item-tax-vat-phase-2-discovery.md §5): this pre-check
      // previously used lte/gte (inclusive) on both ends, which is
      // STRICTER than the actual EXCLUDE USING gist constraint below —
      // 025_tax_rates_no_overlap_exclusion.sql uses
      // daterange(effective_from, effective_to, '[)'), a genuinely
      // half-open range, so two rates where one's effectiveFrom equals
      // the other's effectiveTo do NOT truly overlap (proved directly
      // at the DB level: both inserts succeed with no CHECK/EXCLUDE
      // violation). The inclusive lte/gte pre-check incorrectly
      // rejected that exact, legitimate case with a 409 before the
      // INSERT was ever attempted. Corrected to strict lt/gt so the
      // pre-check accepts exactly what the EXCLUDE constraint accepts
      // — no case that used to be rejected by the (correct) EXCLUDE
      // constraint is newly accepted; this only stops the pre-check
      // from being falsely stricter than the constraint it exists to
      // preview.
      const overlapping = await tx
        .select()
        .from(taxRates)
        .where(
          and(
            eq(taxRates.tenantId, tenantId),
            eq(taxRates.legalEntityId, legalEntityId),
            eq(taxRates.taxCodeId, taxCodeId),
            lt(taxRates.effectiveFrom, dto.effectiveTo ?? "9999-12-31"),
            or(
              isNull(taxRates.effectiveTo),
              gt(taxRates.effectiveTo, dto.effectiveFrom),
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

  /**
   * Tax/VAT Phase 2 (docs/finance-work-item-tax-vat-phase-2-discovery.md
   * §3/§5) — resolves the single tax_rates row effective for `taxCodeId`
   * on `onDate` (the DOCUMENT's own transaction date: bill date / debit
   * note date — Decision 6 — never posting date), for use by
   * SupplierBillsService/SupplierDebitNotesService while they're already
   * inside their own `withTenant()` transaction. Takes `tx` directly
   * (not its own transaction) so it participates in the caller's
   * transaction rather than opening a second one.
   *
   * Validates taxCodeId scope (tenant/legal entity) AND that the code is
   * still active — `tax_codes.isActive` governs future selectability
   * only (Phase 1's own schema comment), and resolving a code onto a NEW
   * line is exactly the "future selectability" this codebase's isActive
   * convention already gates elsewhere (e.g. SuppliersService — only
   * active rows may be newly referenced).
   *
   * Resolution uses the half-open [effectiveFrom, effectiveTo) range
   * from 025_tax_rates_no_overlap_exclusion.sql — the EXCLUDE constraint
   * guarantees at most one row can ever match, so no ordering/tie-break
   * logic is needed. Throws (never silently returns "no tax") when the
   * code doesn't exist/isn't active/isn't in scope, or when no rate
   * covers `onDate` — a real tax code with no effective rate must reject
   * the write, not be silently treated as tax-free.
   */
  async resolveEffectiveRate(
    tx: TxClient,
    tenantId: string,
    legalEntityId: string,
    taxCodeId: string,
    onDate: string,
  ): Promise<TaxRate> {
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
    if (!taxCode.isActive) {
      throw new BadRequestException(
        `Tax code "${taxCode.code}" is inactive and cannot be selected on a new line.`,
      );
    }

    const rows = await tx
      .select()
      .from(taxRates)
      .where(
        and(
          eq(taxRates.tenantId, tenantId),
          eq(taxRates.legalEntityId, legalEntityId),
          eq(taxRates.taxCodeId, taxCodeId),
          lte(taxRates.effectiveFrom, onDate),
          or(isNull(taxRates.effectiveTo), gt(taxRates.effectiveTo, onDate)),
        ),
      )
      .limit(1);
    const rate = rows[0];
    if (!rate) {
      throw new BadRequestException(
        `Tax code "${taxCode.code}" has no effective tax rate covering ${onDate}.`,
      );
    }
    return rate;
  }
}
