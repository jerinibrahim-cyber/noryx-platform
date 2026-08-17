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
 * Wraps every successful controller return value in the shared ApiSuccess
 * envelope (@noryx/shared-types) so every service — not just identity —
 * returns a consistent shape. Errors are handled separately by
 * AllExceptionsFilter, which produces the matching ApiError shape.
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<
  T,
  ApiSuccess<T>
> {
  intercept(
    _ctx: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiSuccess<T>> {
    return next.handle().pipe(map((data) => ({ ok: true as const, data })));
  }
}
