import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { TestWorkflowEnvironment } from '@temporalio/testing';

const cleanup = [];
async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function start(command, args, env) {
  const process = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  process.stdout.on('data', chunk => { output += chunk.toString(); });
  process.stderr.on('data', chunk => { output += chunk.toString(); });
  const exited = once(process, 'exit');
  cleanup.push(async () => {
    if (process.exitCode === null && process.signalCode === null) {
      process.kill('SIGTERM');
      await Promise.race([exited, delay(10000, undefined, { ref: false }).then(() => { if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL'); })]);
    }
  });
  return { process, exited, output: () => output };
}

async function ready(url, child) {
  const deadline = Date.now() + 30000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.process.exitCode !== null) throw new Error(child.output());
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      const body = await response.json();
      if (response.ok) return body;
    } catch (error) { lastError = error; }
    await delay(100);
  }
  throw new Error(`Readiness timed out: ${child.output()}`, { cause: lastError });
}

try {
  const redisPort = await freePort();
  const redis = start(process.env.REDIS_SERVER_PATH ?? 'redis-server', ['--bind', '127.0.0.1', '--port', String(redisPort), '--save', '', '--appendonly', 'no'], process.env);
  await new Promise((resolve, reject) => {
    redis.process.once('error', reject);
    redis.process.stdout.on('data', chunk => { if (chunk.toString().includes('Ready to accept connections')) resolve(); });
  });
  const temporal = await TestWorkflowEnvironment.createLocal({ server: {
    log: { format: 'json', level: 'error' },
    ...(process.env.TEMPORAL_CLI_PATH ? { executable: { type: 'existing-path', path: process.env.TEMPORAL_CLI_PATH } } : {})
  } });
  cleanup.push(() => temporal.teardown());
  const apiPort = await freePort();
  const workerPort = await freePort();
  const baseUrl = `http://127.0.0.1:${apiPort}`;
  const env = {
    ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'info', PORT: String(apiPort),
    REDIS_URL: `redis://127.0.0.1:${redisPort}`, TEMPORAL_ADDRESS: temporal.address,
    TEMPORAL_NAMESPACE: 'default', TEMPORAL_TASK_QUEUE: `smoke-${apiPort}`,
    WORKER_HEALTH_PORT: String(workerPort), WORKER_HEALTH_URL: `http://127.0.0.1:${workerPort}/ready`,
    SUPPLIER_A_URL: `${baseUrl}/supplierA/hotels`, SUPPLIER_B_URL: `${baseUrl}/supplierB/hotels`,
    SUPPLIER_A_MODE: 'healthy', SUPPLIER_B_MODE: 'healthy'
  };
  const api = start(process.execPath, ['dist/server.js'], env);
  await ready(`${baseUrl}/live`, api);
  const withoutWorker = await fetch(`${baseUrl}/api/hotels?city=delhi`);
  assert.equal(withoutWorker.status, 503);
  assert.equal((await withoutWorker.json()).error.code, 'WORKER_UNAVAILABLE');
  const worker = start(process.execPath, ['dist/temporal/worker.js'], env);
  const health = await ready(`${baseUrl}/health`, worker);
  assert.equal(health.status, 'healthy');
  const collection = start(process.execPath, ['scripts/run-postman.mjs'], { ...env, POSTMAN_BASE_URL: baseUrl });
  const [collectionCode] = await collection.exited;
  console.info(collection.output());
  assert.equal(collectionCode, 0);
  worker.process.kill('SIGTERM');
  const [workerCode] = await worker.exited;
  assert.equal(workerCode, 0);
  assert.equal((await fetch(`${baseUrl}/health`)).status, 503);
  assert.equal((await fetch(`${baseUrl}/api/hotels?city=uncached`)).status, 503);
  assert.equal((await fetch(`${baseUrl}/api/hotels?city=delhi`)).status, 200);
  api.process.kill('SIGTERM');
  const [apiCode] = await api.exited;
  assert.equal(apiCode, 0);
  assert.doesNotMatch(api.output() + worker.output(), /UnhandledPromiseRejection|uncaughtException|startup failed/);
  console.info('Compiled API and worker smoke checks passed, including missing-worker handling, real dependency health, cached availability, collection assertions and graceful SIGTERM.');
} finally {
  for (const dispose of cleanup.reverse()) {
    try { await dispose(); } catch (error) { console.error('Smoke cleanup failed', error); process.exitCode = 1; }
  }
}
