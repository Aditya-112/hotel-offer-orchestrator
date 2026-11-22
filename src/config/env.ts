import { z } from 'zod';

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: positiveInt(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  REDIS_URL: z.url().default('redis://127.0.0.1:6379'),
  CACHE_TTL_SECONDS: positiveInt(60),
  PARTIAL_CACHE_TTL_SECONDS: positiveInt(10),
  TEMPORAL_ADDRESS: z.string().min(1).default('127.0.0.1:7233'),
  TEMPORAL_NAMESPACE: z.string().min(1).default('default'),
  TEMPORAL_TASK_QUEUE: z.string().min(1).default('hotel-offers'),
  SUPPLIER_A_URL: z.url().default('http://127.0.0.1:3000/supplierA/hotels'),
  SUPPLIER_B_URL: z.url().default('http://127.0.0.1:3000/supplierB/hotels'),
  SUPPLIER_A_MODE: z.enum(['healthy', 'unavailable', 'timeout']).default('healthy'),
  SUPPLIER_B_MODE: z.enum(['healthy', 'unavailable', 'timeout']).default('healthy'),
  SUPPLIER_HTTP_TIMEOUT_MS: positiveInt(1500),
  ACTIVITY_START_TO_CLOSE_MS: positiveInt(3000),
  ACTIVITY_SCHEDULE_TO_CLOSE_MS: positiveInt(12000),
  ACTIVITY_MAX_ATTEMPTS: positiveInt(3),
  ACTIVITY_RETRY_INITIAL_MS: positiveInt(250),
  ACTIVITY_RETRY_MAX_MS: positiveInt(1000),
  WORKFLOW_TIMEOUT_MS: positiveInt(20000),
  DEPENDENCY_TIMEOUT_MS: positiveInt(1500),
  WORKER_HEALTH_PORT: positiveInt(3002),
  WORKER_HEALTH_URL: z.url().default('http://127.0.0.1:3002/ready')
}).superRefine((env, ctx) => {
  const reject = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (env.SUPPLIER_HTTP_TIMEOUT_MS >= env.ACTIVITY_START_TO_CLOSE_MS) reject('HTTP timeout must be shorter than activity timeout');
  if (env.ACTIVITY_START_TO_CLOSE_MS > env.ACTIVITY_SCHEDULE_TO_CLOSE_MS) reject('Activity execution timeout must fit within its total timeout');
  if (env.ACTIVITY_SCHEDULE_TO_CLOSE_MS >= env.WORKFLOW_TIMEOUT_MS) reject('Activity total timeout must be shorter than workflow timeout');
  if (env.ACTIVITY_RETRY_INITIAL_MS > env.ACTIVITY_RETRY_MAX_MS) reject('Initial retry delay must not exceed maximum delay');
  if (env.PARTIAL_CACHE_TTL_SECONDS > env.CACHE_TTL_SECONDS) reject('Partial cache TTL must not exceed complete cache TTL');
  for (const port of [env.PORT, env.WORKER_HEALTH_PORT]) if (port > 65535) reject('Invalid TCP port');
  if (!['redis:', 'rediss:'].includes(new URL(env.REDIS_URL).protocol)) reject('REDIS_URL must use redis or rediss');
  for (const url of [env.SUPPLIER_A_URL, env.SUPPLIER_B_URL, env.WORKER_HEALTH_URL]) {
    if (!['http:', 'https:'].includes(new URL(url).protocol)) reject('HTTP dependency URL must use http or https');
  }
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid configuration: ${result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  }
  return result.data;
}
