import type { Client } from '@temporalio/client';
import type { Config } from '../config/env';
import type { RedisClient } from '../redis/cache';
import { supplierOfferSchema } from '../domain/hotels';
import { z } from 'zod';

export type HealthReport = {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: { api: boolean; supplierA: boolean; supplierB: boolean; redis: boolean; temporal: boolean; worker: boolean };
};

export async function probeHttp(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

async function probeSupplier(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const endpoint = new URL(url);
    endpoint.searchParams.set('city', 'delhi');
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) { await response.body?.cancel(); return false; }
    const body: unknown = await response.json();
    return z.array(supplierOfferSchema).max(10000).safeParse(body).success;
  } catch {
    return false;
  }
}

export function createHealthCheck(config: Config, redis: RedisClient, temporal: Client): () => Promise<HealthReport> {
  return async () => {
    const deadline = Date.now() + config.DEPENDENCY_TIMEOUT_MS;
    const checks = await Promise.allSettled([
      probeSupplier(config.SUPPLIER_A_URL, config.DEPENDENCY_TIMEOUT_MS),
      probeSupplier(config.SUPPLIER_B_URL, config.DEPENDENCY_TIMEOUT_MS),
      redis.withCommandOptions({ timeout: config.DEPENDENCY_TIMEOUT_MS }).ping(),
      temporal.connection.withDeadline(deadline, () => temporal.connection.workflowService.describeNamespace({ namespace: config.TEMPORAL_NAMESPACE })),
      probeHttp(config.WORKER_HEALTH_URL, config.DEPENDENCY_TIMEOUT_MS)
    ]);
    const passed = (index: number) => {
      const result = checks[index];
      return result?.status === 'fulfilled' && result.value !== false;
    };
    const report = { api: true, supplierA: passed(0), supplierB: passed(1), redis: passed(2), temporal: passed(3), worker: passed(4) };
    const coreHealthy = report.redis && report.temporal && report.worker;
    const status = !coreHealthy || (!report.supplierA && !report.supplierB) ? 'unhealthy'
      : report.supplierA && report.supplierB ? 'healthy' : 'degraded';
    return { status, checks: report };
  };
}
