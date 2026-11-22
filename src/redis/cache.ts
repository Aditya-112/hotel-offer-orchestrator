import { createClient } from 'redis';
import type { Logger } from 'pino';
import { z } from 'zod';
import { compareOffers, hotelOfferSchema, normalizeHotelName } from '../domain/hotels';
import type { HotelOffer, PriceRange } from '../domain/hotels';
import { AppError } from '../http/errors';

const replaceScript = `
local ttl = tonumber(ARGV[1])
local offers = cjson.decode(ARGV[2])
redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
for _, offer in ipairs(offers) do
  redis.call('ZADD', KEYS[1], offer.price, offer.id)
  redis.call('HSET', KEYS[2], offer.id, offer.json)
end
redis.call('PEXPIRE', KEYS[1], ttl)
redis.call('PEXPIRE', KEYS[2], ttl)
redis.call('SET', KEYS[3], ARGV[3], 'PX', ttl)
return 1
`;

export const rangeScript = `
local marker = redis.call('GET', KEYS[3])
if not marker then return nil end
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], ARGV[1], ARGV[2])
local result = {marker}
for _, id in ipairs(ids) do
  local offer = redis.call('HGET', KEYS[2], id)
  if not offer then return redis.error_reply('CACHE_INCONSISTENT') end
  table.insert(result, offer)
end
return result
`;

export function cityKeys(city: string): [string, string, string] {
  const prefix = `hotels:{${encodeURIComponent(city)}}`;
  return [`${prefix}:prices`, `${prefix}:offers`, `${prefix}:ready`];
}

export function createRedisClient(url: string, logger: Logger) {
  const client = createClient({
    url,
    socket: { connectTimeout: 1500, reconnectStrategy: retries => Math.min(100 * (retries + 1), 1000) },
    disableOfflineQueue: true,
    commandsQueueMaxLength: 1000
  });
  client.on('error', () => logger.error({ dependency: 'redis' }, 'Redis connection error'));
  return client;
}

export type RedisClient = ReturnType<typeof createRedisClient>;
export type CachedHotels = { offers: HotelOffer[]; partial: boolean };
export interface HotelCache {
  read(city: string, range: PriceRange): Promise<CachedHotels | null>;
  replace(city: string, offers: HotelOffer[], ttlMs: number, partial?: boolean): Promise<void>;
}

export class RedisHotelCache implements HotelCache {
  constructor(private readonly client: RedisClient) {}

  async read(city: string, range: PriceRange): Promise<CachedHotels | null> {
    try {
      const raw = await this.client.withCommandOptions({ timeout: 2000 }).eval(rangeScript, {
        keys: cityKeys(city), arguments: [String(range.minPrice ?? '-inf'), String(range.maxPrice ?? '+inf')]
      });
      if (raw === null) return null;
      const [marker, ...records] = z.array(z.string()).min(1).parse(raw);
      const offers = records.map(record => hotelOfferSchema.parse(JSON.parse(record))).sort(compareOffers);
      return { offers, partial: marker === 'partial' };
    } catch {
      throw new AppError(503, 'REDIS_UNAVAILABLE', 'Hotel cache is unavailable.');
    }
  }

  async replace(city: string, offers: HotelOffer[], ttlMs: number, partial = false): Promise<void> {
    try {
      const validated = z.array(hotelOfferSchema).max(20000).parse(offers);
      z.number().int().positive().parse(ttlMs);
      const payload = validated.map(offer => ({ id: normalizeHotelName(offer.name), price: offer.price, json: JSON.stringify(offer) }));
      await this.client.withCommandOptions({ timeout: 2000 }).eval(replaceScript, {
        keys: cityKeys(city), arguments: [String(ttlMs), JSON.stringify(payload), partial ? 'partial' : 'complete']
      });
    } catch {
      throw new AppError(503, 'REDIS_UNAVAILABLE', 'Hotel cache could not be updated.');
    }
  }
}
