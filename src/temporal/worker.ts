import { createServer } from 'node:http';
import { NativeConnection, Worker, Runtime, DefaultLogger } from '@temporalio/worker';
import pino from 'pino';
import { loadConfig } from '../config/env';
import { createSupplierActivities } from './activities';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL });
  Runtime.install({ logger: new DefaultLogger('WARN', entry => logger.warn({ component: 'temporal', timestamp: String(entry.timestampNanos) }, entry.message)) });
  const connection = await NativeConnection.connect({ address: config.TEMPORAL_ADDRESS });
  const worker = await Worker.create({
    connection,
    namespace: config.TEMPORAL_NAMESPACE,
    taskQueue: config.TEMPORAL_TASK_QUEUE,
    workflowsPath: require.resolve('./workflows'),
    activities: createSupplierActivities(config, logger),
    shutdownGraceTime: '10 seconds',
    shutdownForceTime: '15 seconds',
    maxConcurrentActivityTaskExecutions: 32
  });
  const health = createServer((_request, response) => {
    const ready = worker.getState() === 'RUNNING';
    response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: ready ? 'ready' : 'unavailable' }));
  });
  health.listen(config.WORKER_HEALTH_PORT, '0.0.0.0');
  try {
    logger.info({ taskQueue: config.TEMPORAL_TASK_QUEUE }, 'Starting Temporal worker');
    await worker.run();
  } finally {
    health.close();
    await connection.close();
  }
}

void main().catch(() => {
  pino().fatal('Worker startup or execution failed. Check configuration and Temporal readiness.');
  process.exit(1);
});
