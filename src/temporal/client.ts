import { randomUUID } from 'node:crypto';
import { Client, Connection, WorkflowFailedError } from '@temporalio/client';
import { ApplicationFailure, TimeoutFailure } from '@temporalio/common';
import type { Config } from '../config/env';
import type { AggregationResult } from '../domain/hotels';
import { AppError } from '../http/errors';
import type { HotelWorkflow, WorkflowSettings } from './contracts';

export function workflowSettings(config: Config): WorkflowSettings {
  return {
    startToCloseMs: config.ACTIVITY_START_TO_CLOSE_MS,
    scheduleToCloseMs: config.ACTIVITY_SCHEDULE_TO_CLOSE_MS,
    maximumAttempts: config.ACTIVITY_MAX_ATTEMPTS,
    retryInitialMs: config.ACTIVITY_RETRY_INITIAL_MS,
    retryMaxMs: config.ACTIVITY_RETRY_MAX_MS
  };
}

export async function connectTemporal(config: Config): Promise<{ client: Client; connection: Connection }> {
  const connection = await Connection.connect({ address: config.TEMPORAL_ADDRESS, connectTimeout: config.DEPENDENCY_TIMEOUT_MS });
  return { connection, client: new Client({ connection, namespace: config.TEMPORAL_NAMESPACE }) };
}

function translateFailure(error: unknown): AppError {
  if (error instanceof WorkflowFailedError && error.cause instanceof ApplicationFailure) {
    if (error.cause.type === 'SUPPLIER_TIMEOUT') return new AppError(504, 'SUPPLIER_TIMEOUT', 'Suppliers timed out before a usable dataset was available.');
    if (error.cause.type === 'SUPPLIER_UNAVAILABLE') return new AppError(502, 'SUPPLIER_UNAVAILABLE', 'Suppliers could not provide a usable dataset.');
  }
  if (error instanceof WorkflowFailedError && error.cause instanceof TimeoutFailure) {
    return new AppError(503, 'TEMPORAL_UNAVAILABLE', 'Hotel aggregation did not complete within its deadline.');
  }
  return new AppError(503, 'TEMPORAL_UNAVAILABLE', 'Hotel orchestration is unavailable.');
}

export class TemporalHotelOrchestrator {
  constructor(private readonly client: Client, private readonly config: Config, private readonly workerReady: () => Promise<boolean>) {}

  async aggregate(city: string, requestId: string): Promise<AggregationResult> {
    if (!await this.workerReady()) throw new AppError(503, 'WORKER_UNAVAILABLE', 'Hotel aggregation worker is unavailable.');
    try {
      return await this.client.connection.withDeadline(Date.now() + this.config.WORKFLOW_TIMEOUT_MS + 1000, () => this.client.workflow.execute<HotelWorkflow>('hotelAggregationWorkflow', {
        workflowId: `hotels-${encodeURIComponent(city)}-${randomUUID()}`,
        taskQueue: this.config.TEMPORAL_TASK_QUEUE,
        workflowRunTimeout: this.config.WORKFLOW_TIMEOUT_MS,
        workflowExecutionTimeout: this.config.WORKFLOW_TIMEOUT_MS,
        args: [{ city, requestId, settings: workflowSettings(this.config) }]
      }));
    } catch (error) {
      throw translateFailure(error);
    }
  }
}
