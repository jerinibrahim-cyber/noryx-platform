import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { map } from "rxjs/operators";
import type { ApiSuccess } from "@noryx/shared-types";

/**
 * Opt-in wrapper for a handler that needs top-level `meta` in the
 * `ApiSuccess` envelope (`{ ok, data, meta }`), not just a bare payload
 * — e.g. 2d's paginated Account Ledger (`PaginatedResponse<LedgerLine>`)
 * and Trial Balance (`meta: TrialBalanceMeta`),
 * docs/finance-2d-general-ledger-read-layer-proposal.md §2.1.9/§5.1.6.
 * `ResponseInterceptor` below unwraps this one level; every other
 * handler's return value passes through completely unchanged — no
 * existing route (Accounts, Accounting Periods, Journal Entries) ever
 * returns an instance of this class, so this is purely additive.
 */
export class ApiSuccessWithMeta<T, M extends object = Record<string, unknown>> {
  constructor(
    public readonly data: T,
    public readonly meta: M,
  ) {}
}

// Copied from services/identity's ResponseInterceptor — generic, no
// Identity-specific logic. Wraps every successful response in the shared
// ApiSuccess envelope so every service returns a consistent shape. The
// ApiSuccessWithMeta branch is a 2d addition (see that class's doc
// comment) — the rest is unchanged from the original copy.
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<
  T,
  ApiSuccess<T>
> {
  intercept(
    _ctx: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiSuccess<T>> {
    return next.handle().pipe(
      map((result) =>
        result instanceof ApiSuccessWithMeta
          ? {
              ok: true as const,
              data: result.data,
              meta: result.meta as unknown as Record<string, unknown>,
            }
          : { ok: true as const, data: result },
      ),
    );
  }
}
