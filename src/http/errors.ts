export type ErrorCode = 'INVALID_CITY' | 'INVALID_MIN_PRICE' | 'INVALID_MAX_PRICE' | 'INVALID_PRICE_RANGE'
  | 'SUPPLIER_TIMEOUT' | 'SUPPLIER_UNAVAILABLE' | 'TEMPORAL_UNAVAILABLE' | 'REDIS_UNAVAILABLE'
  | 'WORKER_UNAVAILABLE' | 'NOT_FOUND' | 'INTERNAL_ERROR';

export class AppError extends Error {
  constructor(readonly status: number, readonly code: ErrorCode, message: string) {
    super(message);
    this.name = 'AppError';
  }
}
