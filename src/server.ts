import pino from 'pino';
import { createApp } from './app';
import { loadConfig } from './config/env';
import { createHealthCheck, probeHttp } from './http/health';
import { createRedisClient, RedisHotelCache } from './redis/cache';
import { HotelService } from './service';
import { connectTemporal, TemporalHotelOrchestrator } from './temporal/client';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL });
  const redis = createRedisClient(config.REDIS_URL, logger);
  const { client, connection } = await connectTemporal(config);
  await redis.connect();
  const service = new HotelService(new RedisHotelCache(redis), new TemporalHotelOrchestrator(client, config,
    () => probeHttp(config.WORKER_HEALTH_URL, config.DEPENDENCY_TIMEOUT_MS)), config, logger);
  const app = createApp({ config, logger, findHotels: (query, requestId) => service.find(query, requestId), health: createHealthCheck(config, redis, client) });
  const server = app.listen(config.PORT, '0.0.0.0', () => logger.info({ port: config.PORT }, 'API listening'));
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    logger.info('API shutting down');
    const deadline = setTimeout(() => { server.closeAllConnections(); process.exit(1); }, config.WORKFLOW_TIMEOUT_MS + 5000).unref();
    server.close(() => {
      void Promise.allSettled([redis.close(), connection.close()]).then(() => clearTimeout(deadline));
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

void main().catch(() => {
  pino().fatal('API startup failed. Check configuration and dependency readiness.');
  process.exit(1);
});
