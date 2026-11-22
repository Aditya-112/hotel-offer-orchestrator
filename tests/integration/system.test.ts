import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { NextFunction } from 'express';
import request from 'supertest';
import pino from 'pino';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Client, Connection } from '@temporalio/client';
import { bundleWorkflowCode, DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config/env';
import type { Config } from '../../src/config/env';
import { cityKeys, createRedisClient, RedisHotelCache } from '../../src/redis/cache';
import type { RedisClient } from '../../src/redis/cache';
import { HotelService } from '../../src/service';
import { createSupplierActivities } from '../../src/temporal/activities';
import { TemporalHotelOrchestrator, workflowSettings } from '../../src/temporal/client';
import type { HotelWorkflow } from '../../src/temporal/contracts';
import { aggregateOffers } from '../../src/domain/hotels';
import type { HotelOffer } from '../../src/domain/hotels';
import { supplierData } from '../../src/suppliers/data';
import { createHealthCheck } from '../../src/http/health';

const logger = pino({ level: 'silent' });
const expected = aggregateOffers([
  { supplier: 'Supplier A', offers: supplierData['Supplier A'].filter(offer => offer.city === 'delhi') },
  { supplier: 'Supplier B', offers: supplierData['Supplier B'].filter(offer => offer.city === 'delhi') }
]);
type Fault = 'healthy' | 'down' | 'timeout' | 'transient' | 'invalid';

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Cannot allocate test port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

describe('real Redis, Temporal, HTTP suppliers and Express', () => {
  let environment: TestWorkflowEnvironment;
  let redisProcess: ChildProcess;
  let redis: RedisClient;
  let cache: RedisHotelCache;
  let worker: Worker;
  let workerRun: Promise<void>;
  let server: Server;
  let config: Config;
  let app: ReturnType<typeof createApp>;
  let workerReady = true;
  const faults: Record<string, Fault> = { A: 'healthy', B: 'healthy' };
  const calls: Record<string, number> = { A: 0, B: 0 };
  let gate: NextFunction[] | null = null;
  const cleanup: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    Runtime.install({ logger: new DefaultLogger('ERROR') });
    const redisPort = await freePort();
    redisProcess = spawn(process.env.REDIS_SERVER_PATH ?? 'redis-server', ['--bind', '127.0.0.1', '--port', String(redisPort), '--save', '', '--appendonly', 'no'], { stdio: ['ignore', 'pipe', 'pipe'] });
    cleanup.push(async () => {
      if (redisProcess.exitCode === null && redisProcess.signalCode === null) { redisProcess.kill('SIGTERM'); await once(redisProcess, 'exit'); }
    });
    await new Promise<void>((resolve, reject) => {
      redisProcess.once('error', reject);
      redisProcess.once('exit', code => reject(new Error(`Test Redis exited early: ${String(code)}`)));
      redisProcess.stdout?.on('data', (chunk: Buffer) => { if (chunk.toString().includes('Ready to accept connections')) resolve(); });
    });
    environment = await TestWorkflowEnvironment.createLocal({ server: {
      ...(process.env.TEMPORAL_CLI_PATH ? { executable: { type: 'existing-path' as const, path: process.env.TEMPORAL_CLI_PATH } } : {}),
      log: { format: 'json', level: 'error' }
    } });
    cleanup.push(() => environment.teardown());
    const router = express();
    router.use((req, res, next) => {
      const supplier = req.path === '/supplierA/hotels' ? 'A' : req.path === '/supplierB/hotels' ? 'B' : undefined;
      if (!supplier) return next();
      calls[supplier] = (calls[supplier] ?? 0) + 1;
      const fault = faults[supplier];
      if (fault === 'down' || (fault === 'transient' && calls[supplier] === 1)) { res.status(503).json({ error: 'unavailable' }); return; }
      if (fault === 'timeout') return;
      if (fault === 'invalid') { res.json([{ name: 'Broken', price: -1 }]); return; }
      if (gate) {
        gate.push(next);
        if (gate.length === 2) { const waiting = gate; gate = null; waiting.forEach(proceed => proceed()); }
        return;
      }
      next();
    });
    server = router.listen(0, '127.0.0.1');
    cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    config = loadConfig({
      NODE_ENV: 'test', LOG_LEVEL: 'silent', REDIS_URL: `redis://127.0.0.1:${redisPort}`,
      SUPPLIER_A_URL: `${baseUrl}/supplierA/hotels`, SUPPLIER_B_URL: `${baseUrl}/supplierB/hotels`,
      SUPPLIER_HTTP_TIMEOUT_MS: '150', ACTIVITY_START_TO_CLOSE_MS: '1000',
      ACTIVITY_SCHEDULE_TO_CLOSE_MS: '4000', WORKFLOW_TIMEOUT_MS: '6000',
      ACTIVITY_RETRY_INITIAL_MS: '20', ACTIVITY_RETRY_MAX_MS: '40',
      DEPENDENCY_TIMEOUT_MS: '250', TEMPORAL_TASK_QUEUE: `test-${randomUUID()}`,
      PARTIAL_CACHE_TTL_SECONDS: '1'
    });
    redis = createRedisClient(config.REDIS_URL, logger);
    await redis.connect();
    cleanup.push(async () => { if (redis.isOpen) await redis.close(); });
    cache = new RedisHotelCache(redis);
    const workflowBundle = await bundleWorkflowCode({ workflowsPath: require.resolve('../../src/temporal/workflows.ts') });
    worker = await Worker.create({
      connection: environment.nativeConnection, taskQueue: config.TEMPORAL_TASK_QUEUE, workflowBundle,
      activities: createSupplierActivities(config, logger), shutdownGraceTime: '1s'
    });
    workerRun = worker.run();
    cleanup.push(async () => { if (worker.getState() === 'RUNNING') worker.shutdown(); await workerRun; });
    const orchestrator = new TemporalHotelOrchestrator(environment.client, config, () => Promise.resolve(workerReady));
    const service = new HotelService(cache, orchestrator, config, logger);
    app = createApp({ config, logger, findHotels: (query, requestId) => service.find(query, requestId), health: createHealthCheck(config, redis, environment.client) });
    router.use(app);
  });

  beforeEach(async () => {
    faults.A = 'healthy'; faults.B = 'healthy'; calls.A = 0; calls.B = 0; gate = null; workerReady = true;
    await redis.flushDb();
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    for (const dispose of cleanup.reverse()) {
      try { await dispose(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Integration cleanup failed');
  });

  it('executes the complete request flow with exact selected offers and supplier commissions', async () => {
    const response = await request(app).get('/api/hotels?city=delhi').expect(200);
    expect(response.body).toEqual(expected);
    expect(calls).toEqual({ A: 1, B: 1 });
    expect(await cache.read('delhi', {})).toEqual({ offers: expected, partial: false });
    expect(await redis.zScore(cityKeys('delhi')[0], 'holtin')).toBe(5340);
    await request(app).get('/api/hotels?city=delhi').expect(200, expected);
    expect(calls).toEqual({ A: 1, B: 1 });
  });

  it('starts both supplier activities concurrently using an arrival barrier', async () => {
    gate = [];
    await request(app).get('/api/hotels?city=delhi').expect(200, expected);
    expect(gate).toBeNull();
    expect(calls).toEqual({ A: 1, B: 1 });
  });

  it.each([
    ['minPrice=5000&maxPrice=6000', ['Holtin', 'Radison']],
    ['minPrice=6000', ['The Imperial']],
    ['maxPrice=4500', ['Lotus Residency', 'City Garden']],
    ['minPrice=4500&maxPrice=4500', ['City Garden']],
    ['minPrice=1&maxPrice=2', []]
  ])('populates and filters Redis for a first request with %s', async (query, names) => {
    const response = await request(app).get(`/api/hotels?city=delhi&${query}`).expect(200);
    expect(response.body).toEqual(expected.filter(offer => names.includes(offer.name)));
    expect(await redis.zCard(cityKeys('delhi')[0])).toBe(5);
  });

  it('executes ZRANGEBYSCORE and HGET inside Redis, without reading the full hash', async () => {
    await cache.replace('delhi', expected, 60000);
    await redis.configSet('slowlog-log-slower-than', '0');
    await redis.sendCommand(['SLOWLOG', 'RESET']);
    expect((await cache.read('delhi', { minPrice: 5340, maxPrice: 5340 }))?.offers).toEqual([expected[2]]);
    const log: unknown = await redis.sendCommand(['SLOWLOG', 'GET', '100']);
    const serialized = JSON.stringify(log).toLowerCase();
    expect(serialized).toContain('zrangebyscore');
    expect(serialized).toContain('hget');
    expect(serialized).not.toContain('hgetall');
    await redis.configSet('slowlog-log-slower-than', '10000');
  });

  it('isolates city keys and handles empty and unknown cities', async () => {
    await request(app).get('/api/hotels?city=delhi').expect(200);
    await request(app).get('/api/hotels?city=mumbai').expect(200).expect(response => expect(response.body).toHaveLength(3));
    await request(app).get('/api/hotels?city=jaipur').expect(200, []);
    await request(app).get('/api/hotels?city=atlantis').expect(200, []);
    expect(await cache.read('delhi', {})).toEqual({ offers: expected, partial: false });
    expect(await cache.read('jaipur', {})).toEqual({ offers: [], partial: false });
  });

  it('distinguishes a cache miss from an empty cached dataset', async () => {
    expect(await cache.read('delhi', {})).toBeNull();
    await cache.replace('delhi', [], 60000);
    expect(await cache.read('delhi', {})).toEqual({ offers: [], partial: false });
    expect(await redis.pTTL(cityKeys('delhi')[2])).toBeGreaterThan(0);
  });

  it('expires all city structures at the same server deadline', async () => {
    await cache.replace('delhi', expected, 60000);
    const keys = cityKeys('delhi');
    const deadlines = await Promise.all(keys.map(key => redis.sendCommand(['PEXPIRETIME', key])));
    expect(new Set(deadlines).size).toBe(1);
    await redis.multi().pExpire(keys[0], 0).pExpire(keys[1], 0).pExpire(keys[2], 0).exec();
    expect(await cache.read('delhi', {})).toBeNull();
  });

  it('atomically replaces smaller datasets without leaving stale index entries', async () => {
    await cache.replace('delhi', expected, 60000);
    const smaller: HotelOffer[] = [{ name: 'Replacement', price: 1, supplier: 'Supplier A', commissionPct: 3 }];
    const observations = await Promise.all([
      cache.read('delhi', {}), cache.replace('delhi', smaller, 60000),
      ...Array.from({ length: 10 }, () => cache.read('delhi', {}))
    ]);
    for (const result of observations) {
      if (result) expect([expected, smaller]).toContainEqual(result.offers);
    }
    expect(await cache.read('delhi', {})).toEqual({ offers: smaller, partial: false });
    expect(await redis.zCard(cityKeys('delhi')[0])).toBe(1);
    expect(await redis.hLen(cityKeys('delhi')[1])).toBe(1);
  });

  it('returns partial offers after bounded supplier failure retries', async () => {
    faults.A = 'down';
    const response = await request(app).get('/api/hotels?city=delhi').expect(200);
    expect(response.headers['x-hotel-data-status']).toBe('partial');
    expect(response.body).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Holtin', supplier: 'Supplier B', price: 5340, commissionPct: 20 })]));
    expect(calls).toEqual({ A: 3, B: 1 });
    expect(await redis.pTTL(cityKeys('delhi')[2])).toBeLessThanOrEqual(1000);
    expect((await cache.read('delhi', {}))?.partial).toBe(true);
  });

  it('retries a transient supplier error and then produces complete data', async () => {
    faults.A = 'transient';
    const response = await request(app).get('/api/hotels?city=delhi').expect(200, expected);
    expect(response.headers['x-hotel-data-status']).toBeUndefined();
    expect(calls).toEqual({ A: 2, B: 1 });
  });

  it('returns a controlled service error when both suppliers fail, without caching empty results', async () => {
    faults.A = 'down'; faults.B = 'down';
    await request(app).get('/api/hotels?city=delhi').expect(502).expect(response => expect(response.body).toMatchObject({ error: { code: 'SUPPLIER_UNAVAILABLE' } }));
    expect(calls).toEqual({ A: 3, B: 3 });
    expect(await cache.read('delhi', {})).toBeNull();
  });

  it('does not misrepresent a supplier failure plus an empty supplier as an empty success', async () => {
    faults.A = 'down';
    await request(app).get('/api/hotels?city=jaipur').expect(502);
    expect(await cache.read('jaipur', {})).toBeNull();
  });

  it('times out stalled HTTP suppliers, retries boundedly, and returns 504', async () => {
    faults.A = 'timeout'; faults.B = 'timeout';
    await request(app).get('/api/hotels?city=delhi').expect(504).expect(response => expect(response.body).toMatchObject({ error: { code: 'SUPPLIER_TIMEOUT' } }));
    expect(calls).toEqual({ A: 3, B: 3 });
  });

  it('does not retry malformed supplier payloads and preserves the other supplier', async () => {
    faults.A = 'invalid';
    await request(app).get('/api/hotels?city=delhi').expect(200);
    expect(calls).toEqual({ A: 1, B: 1 });
  });

  it('enforces Temporal activity timeouts independently of HTTP timeouts', async () => {
    faults.A = 'timeout'; faults.B = 'timeout';
    await expect(environment.client.workflow.execute<HotelWorkflow>('hotelAggregationWorkflow', {
      workflowId: randomUUID(), taskQueue: config.TEMPORAL_TASK_QUEUE, workflowExecutionTimeout: 6000,
      args: [{ city: 'delhi', requestId: 'timeout-test', settings: { ...workflowSettings(config), startToCloseMs: 50, maximumAttempts: 1 } }]
    })).rejects.toMatchObject({ cause: { type: 'SUPPLIER_TIMEOUT' } });
  });

  it('returns a controlled failure for a missing worker before starting a workflow', async () => {
    workerReady = false;
    await request(app).get('/api/hotels?city=delhi').expect(503).expect(response => expect(response.body).toMatchObject({ error: { code: 'WORKER_UNAVAILABLE' } }));
    expect(calls).toEqual({ A: 0, B: 0 });
  });

  it('detects supplier outages through real HTTP health probes', async () => {
    const base = config.SUPPLIER_A_URL.replace('/supplierA/hotels', '');
    const check = createHealthCheck({ ...config, WORKER_HEALTH_URL: `${base}/live` }, redis, environment.client);
    expect((await check()).status).toBe('healthy');
    faults.A = 'down';
    expect(await check()).toMatchObject({ status: 'degraded', checks: { supplierA: false, supplierB: true } });
    faults.B = 'down';
    expect((await check()).status).toBe('unhealthy');
  });

  it('reports a disconnected Redis client explicitly', async () => {
    const disconnected = createRedisClient(config.REDIS_URL, logger);
    await expect(new RedisHotelCache(disconnected).read('delhi', {})).rejects.toMatchObject({ status: 503, code: 'REDIS_UNAVAILABLE' });
  });

  it('reports a disconnected Temporal client explicitly', async () => {
    const connection = await Connection.connect({ address: environment.address });
    await connection.close();
    const orchestrator = new TemporalHotelOrchestrator(new Client({ connection }), config, () => Promise.resolve(true));
    await expect(orchestrator.aggregate('delhi', 'closed-client')).rejects.toMatchObject({ status: 503, code: 'TEMPORAL_UNAVAILABLE' });
  });

  it('bounds a workflow submitted to a queue without a polling worker', async () => {
    const orchestrator = new TemporalHotelOrchestrator(environment.client, {
      ...config, TEMPORAL_TASK_QUEUE: 'unpolled-test-queue', WORKFLOW_TIMEOUT_MS: 300
    }, () => Promise.resolve(true));
    await expect(orchestrator.aggregate('delhi', 'unpolled-worker')).rejects.toMatchObject({ status: 503, code: 'TEMPORAL_UNAVAILABLE' });
  });
});
