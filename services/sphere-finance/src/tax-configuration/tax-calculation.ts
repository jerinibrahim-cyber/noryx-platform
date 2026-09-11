/**
 * Tax/VAT Phase 2 (docs/finance-work-item-tax-vat-phase-2-discovery.md
 * §2/§7) — the single shared line-level tax calculation formula, used
 * identically by SupplierBillsService and SupplierDebitNotesService.
 * Pure, stateless integer minor-unit arithmetic — no floating point, no
 * DB access, no dependency on this module's own services.
 *
 * Defined once here rather than duplicated per service. This is a
 * deliberate departure from this codebase's usual "duplicate the
 * trivial single-table lookup locally" convention (see
 * SupplierBillsService.resolveCurrency and
 * SupplierDebitNotesService.resolveCurrency, which duplicate a
 * single-row query verbatim): this is correctness-critical shared
 * arithmetic, not a trivial query, and any divergence between two
 * hand-duplicated copies would silently produce different tax amounts
 * for the same inputs.
 *
 * Round-half-up on the one division (Decision 2 — line-level integer
 * minor-unit rounding), matching `Math.round`'s behavior for
 * non-negative inputs. `amountMinor` is always > 0 (enforced by the
 * `supplier_bill_lines_amount_positive` / `supplier_debit_note_lines_
 * amount_positive` CHECK constraints on every caller's input) and
 * `rateBasisPoints` is always >= 0 (`tax_rates_rate_non_negative`), so
 * the product is always non-negative and `Math.round`'s half-up
 * behavior is unambiguous.
 */
export function calculateTaxAmountMinor(
  amountMinor: number,
  rateBasisPoints: number,
): number {
  return Math.round((amountMinor * rateBasisPoints) / 10000);
}
