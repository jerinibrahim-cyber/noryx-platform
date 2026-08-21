/** Consistent response shape across every REST endpoint, internal or public. */
export interface ApiSuccess<T> {
  ok: true;
  data: T;
  meta?: Record<string, unknown>;
}

export interface ApiError {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export interface PaginatedMeta {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export type PaginatedResponse<T> = ApiSuccess<T[]> & { meta: PaginatedMeta };

/** Ledger-specific pagination metadata (sphere-finance's General Ledger
 * read layer, "2d" — docs/finance-2d-general-ledger-read-layer-proposal.md
 * §2.1.9). Extends, never modifies, `PaginatedMeta` — every existing
 * consumer of `PaginatedMeta`/`PaginatedResponse` is unaffected; this is
 * the first real consumer of either type. */
export interface LedgerMeta extends PaginatedMeta {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
  normalBalance: "DEBIT" | "CREDIT";
  openingBalanceMinor: number;
  effectiveDateFrom: string | null;
  effectiveDateTo: string;
}
