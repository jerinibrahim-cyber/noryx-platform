import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { map } from "rxjs/operators";
import type { ApiSuccess } from "@noryx/shared-types";

// Copied from services/identity's ResponseInterceptor — generic, no
// Identity-specific logic. Wraps every successful response in the shared
// ApiSuccess envelope so every service returns a consistent shape.
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
