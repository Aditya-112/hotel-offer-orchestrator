import type { HotelQuery } from '../domain/hotels';
import { AppError } from './errors';

export function parseCity(value: unknown): string {
  if (typeof value !== 'string' || !/^[\p{L}][\p{L} .'-]{0,79}$/u.test(value.trim())) {
    throw new AppError(400, 'INVALID_CITY', 'city is required and must be a city name of 1–80 characters.');
  }
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function parsePrice(value: unknown, bound: 'minPrice' | 'maxPrice'): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim()) || !Number.isFinite(Number(value))) {
    throw new AppError(400, bound === 'minPrice' ? 'INVALID_MIN_PRICE' : 'INVALID_MAX_PRICE', `${bound} must be a finite, nonnegative decimal number.`);
  }
  return Number(value);
}

export function parseHotelQuery(query: Record<string, unknown>): HotelQuery {
  const city = parseCity(query.city);
  const minPrice = parsePrice(query.minPrice, 'minPrice');
  const maxPrice = parsePrice(query.maxPrice, 'maxPrice');
  if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
    throw new AppError(400, 'INVALID_PRICE_RANGE', 'minPrice must not exceed maxPrice.');
  }
  return { city, ...(minPrice === undefined ? {} : { minPrice }), ...(maxPrice === undefined ? {} : { maxPrice }) };
}
