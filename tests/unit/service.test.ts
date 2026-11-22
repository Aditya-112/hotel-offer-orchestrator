import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { HotelService } from '../../src/service';
import type { HotelCache } from '../../src/redis/cache';
import type { HotelOrchestrator } from '../../src/service';
import type { AggregationResult } from '../../src/domain/hotels';
import { loadConfig } from '../../src/config/env';

describe('cache freshness and request coalescing', () => {
  const config = loadConfig({});
  const logger = pino({ level: 'silent' });

  it('shares one refresh per city and queries Redis with each caller’s bounds', async () => {
    const read = vi.fn<HotelCache['read']>().mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue({ offers: [], partial: false });
    const replace = vi.fn<HotelCache['replace']>().mockResolvedValue();
    const aggregate = vi.fn<HotelOrchestrator['aggregate']>().mockResolvedValue({ offers: [], failures: [] });
    const service = new HotelService({ read, replace }, { aggregate }, config, logger);
    await Promise.all([service.find({ city: 'delhi', minPrice: 1 }, 'a'), service.find({ city: 'delhi', maxPrice: 2 }, 'b')]);
    expect(aggregate).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('delhi', [], 60000, false);
    expect(read).toHaveBeenLastCalledWith('delhi', { city: 'delhi', maxPrice: 2 });
  });

  it('serves cached empty cities without invoking Temporal', async () => {
    const cache: HotelCache = { read: vi.fn().mockResolvedValue({ offers: [], partial: false }), replace: vi.fn() };
    const aggregate = vi.fn<HotelOrchestrator['aggregate']>();
    expect(await new HotelService(cache, { aggregate }, config, logger).find({ city: 'jaipur' }, 'a')).toEqual({ offers: [], partial: false });
    expect(aggregate).not.toHaveBeenCalled();
  });

  it('uses shorter expiry for partial datasets', async () => {
    const result: AggregationResult = { offers: [{ name: 'Holtin', price: 6000, supplier: 'Supplier A', commissionPct: 10 }], failures: [{ supplier: 'Supplier B', reason: 'unavailable' }] };
    const replace = vi.fn<HotelCache['replace']>().mockResolvedValue();
    const cache: HotelCache = { read: vi.fn<HotelCache['read']>().mockResolvedValueOnce(null).mockResolvedValue({ offers: result.offers, partial: true }), replace };
    const service = new HotelService(cache, { aggregate: () => Promise.resolve(result) }, config, logger);
    await service.find({ city: 'delhi' }, 'a');
    expect(replace).toHaveBeenCalledWith('delhi', result.offers, 10000, true);
  });

  it('rejects invalid timeout and cache configuration', () => {
    expect(() => loadConfig({ SUPPLIER_HTTP_TIMEOUT_MS: '5000' })).toThrow(/HTTP timeout/);
    expect(() => loadConfig({ REDIS_URL: 'http://localhost' })).toThrow(/redis or rediss/);
    expect(() => loadConfig({ PARTIAL_CACHE_TTL_SECONDS: '61' })).toThrow(/Partial cache TTL/);
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/port/);
  });
});
