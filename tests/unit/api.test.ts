import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config/env';
import { AppError } from '../../src/http/errors';
import type { HealthReport } from '../../src/http/health';
import type { CachedHotels } from '../../src/redis/cache';

const health: HealthReport = { status: 'healthy', checks: { api: true, supplierA: true, supplierB: true, redis: true, temporal: true, worker: true } };
function setup() {
  const findHotels = vi.fn<() => Promise<CachedHotels>>().mockResolvedValue({ offers: [], partial: false });
  const app = createApp({ config: loadConfig({}), logger: pino({ level: 'silent' }), findHotels, health: () => Promise.resolve(health) });
  return { app, findHotels };
}

describe('HTTP contracts and input validation', () => {
  it.each([
    ['', 'INVALID_CITY'], ['?city=', 'INVALID_CITY'], ['?city=123', 'INVALID_CITY'],
    ['?city=a&city=b', 'INVALID_CITY'], ['?city[]=delhi', 'INVALID_CITY'], ['?city=' + 'a'.repeat(81), 'INVALID_CITY'],
    ['?city=delhi&minPrice=abc', 'INVALID_MIN_PRICE'], ['?city=delhi&minPrice=-1', 'INVALID_MIN_PRICE'],
    ['?city=delhi&minPrice=Infinity', 'INVALID_MIN_PRICE'], ['?city=delhi&minPrice=', 'INVALID_MIN_PRICE'],
    ['?city=delhi&minPrice=0x20', 'INVALID_MIN_PRICE'], ['?city=delhi&minPrice=1&minPrice=2', 'INVALID_MIN_PRICE'],
    ['?city=delhi&maxPrice=NaN', 'INVALID_MAX_PRICE'], ['?city=delhi&maxPrice=-1', 'INVALID_MAX_PRICE'],
    ['?city=delhi&maxPrice=Infinity', 'INVALID_MAX_PRICE'], ['?city=delhi&maxPrice=abc', 'INVALID_MAX_PRICE'],
    ['?city=delhi&minPrice=6000&maxPrice=5000', 'INVALID_PRICE_RANGE']
  ])('rejects invalid query %s', async (query, code) => {
    const { app, findHotels } = setup();
    const response = await request(app).get(`/api/hotels${query}`).expect(400);
    expect(response.body).toMatchObject({ error: { code } });
    expect(findHotels).not.toHaveBeenCalled();
    expect(response.headers['x-request-id']).toBeTruthy();
  });

  it.each([
    ['?city=%20DELHI%20', { city: 'delhi' }],
    ['?city=atlantis', { city: 'atlantis' }],
    ['?city=delhi&minPrice=5000', { city: 'delhi', minPrice: 5000 }],
    ['?city=delhi&maxPrice=6000', { city: 'delhi', maxPrice: 6000 }],
    ['?city=delhi&minPrice=5000&maxPrice=6000', { city: 'delhi', minPrice: 5000, maxPrice: 6000 }],
    ['?city=delhi&minPrice=0&maxPrice=0', { city: 'delhi', minPrice: 0, maxPrice: 0 }],
    ['?city=delhi&minPrice=.5', { city: 'delhi', minPrice: 0.5 }]
  ])('passes normalized query %s to the service', async (query, parsed) => {
    const { app, findHotels } = setup();
    await request(app).get(`/api/hotels${query}`).expect(200, []);
    expect(findHotels).toHaveBeenCalledWith(parsed, expect.any(String));
  });

  it('returns the exact array contract and preserves request IDs', async () => {
    const { app, findHotels } = setup();
    const offers = [{ name: 'Holtin', price: 5340, supplier: 'Supplier B' as const, commissionPct: 20 }];
    findHotels.mockResolvedValue({ offers, partial: true });
    const response = await request(app).get('/api/hotels?city=delhi').set('x-request-id', 'assessment-123').expect(200, offers);
    expect(response.headers['x-request-id']).toBe('assessment-123');
    expect(response.headers['x-hotel-data-status']).toBe('partial');
  });

  it.each([
    [503, 'REDIS_UNAVAILABLE'], [503, 'TEMPORAL_UNAVAILABLE'], [503, 'WORKER_UNAVAILABLE'],
    [502, 'SUPPLIER_UNAVAILABLE'], [504, 'SUPPLIER_TIMEOUT']
  ] as const)('preserves controlled %s %s errors', async (status, code) => {
    const { app, findHotels } = setup();
    findHotels.mockRejectedValue(new AppError(status, code, 'Dependency unavailable.'));
    await request(app).get('/api/hotels?city=delhi').expect(status).expect(response => expect(response.body).toMatchObject({ error: { code } }));
  });

  it('hides unexpected error details', async () => {
    const { app, findHotels } = setup();
    findHotels.mockRejectedValue(new Error('redis://secret:password@internal:6379 stack'));
    const response = await request(app).get('/api/hotels?city=delhi').expect(500);
    expect(response.text).not.toMatch(/password|internal:6379|stack/);
  });

  it('serves independent supplier datasets with city filtering', async () => {
    const { app } = setup();
    const a = await request(app).get('/supplierA/hotels?city=delhi').expect(200);
    const b = await request(app).get('/supplierB/hotels?city=delhi').expect(200);
    expect(a.body).toEqual(expect.arrayContaining([expect.objectContaining({ hotelId: 'a1', price: 6000 })]));
    expect(b.body).toEqual(expect.arrayContaining([expect.objectContaining({ hotelId: 'b1', price: 5340 })]));
    await request(app).get('/supplierA/hotels?city=jaipur').expect(200, []);
    await request(app).get('/supplierB/hotels?city=atlantis').expect(200, []);
  });

  it('exposes liveness, health, and structured 404s', async () => {
    const { app } = setup();
    await request(app).get('/live').expect(200, { status: 'alive' });
    await request(app).get('/health').expect(200, health);
    await request(app).get('/missing').expect(404).expect(response => expect(response.body).toMatchObject({ error: { code: 'NOT_FOUND' } }));
  });
});
