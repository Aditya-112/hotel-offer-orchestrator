import type { Logger } from 'pino';
import type { Config } from './config/env';
import type { AggregationResult, HotelOffer, HotelQuery } from './domain/hotels';
import type { CachedHotels, HotelCache } from './redis/cache';
import { AppError } from './http/errors';

export interface HotelOrchestrator {
  aggregate(city: string, requestId: string): Promise<AggregationResult>;
}

export class HotelService {
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly cache: HotelCache,
    private readonly orchestrator: HotelOrchestrator,
    private readonly config: Pick<Config, 'CACHE_TTL_SECONDS' | 'PARTIAL_CACHE_TTL_SECONDS'>,
    private readonly logger: Logger
  ) {}

  async find(query: HotelQuery, requestId: string): Promise<CachedHotels> {
    const cached = await this.cache.read(query.city, query);
    if (cached) return cached;
    let refresh = this.inFlight.get(query.city);
    if (!refresh) {
      refresh = this.refresh(query.city, requestId);
      this.inFlight.set(query.city, refresh);
    }
    try {
      await refresh;
    } finally {
      if (this.inFlight.get(query.city) === refresh) this.inFlight.delete(query.city);
    }
    const populated = await this.cache.read(query.city, query);
    if (!populated) throw new AppError(503, 'REDIS_UNAVAILABLE', 'Hotel cache expired before it could be read. Please retry.');
    return populated;
  }

  private async refresh(city: string, requestId: string): Promise<void> {
    const result = await this.orchestrator.aggregate(city, requestId);
    const partial = result.failures.length > 0;
    const ttl = partial ? this.config.PARTIAL_CACHE_TTL_SECONDS : this.config.CACHE_TTL_SECONDS;
    await this.cache.replace(city, result.offers, ttl * 1000, partial);
    this.logger.info({ city, requestId, count: result.offers.length, failures: result.failures, ttlSeconds: ttl }, 'Hotel cache refreshed');
  }
}

export type FindHotels = (query: HotelQuery, requestId: string) => Promise<{ offers: HotelOffer[]; partial: boolean }>;
