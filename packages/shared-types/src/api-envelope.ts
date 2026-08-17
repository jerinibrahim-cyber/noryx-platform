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
