import { ApplicationFailure, TimeoutFailure } from '@temporalio/common';
import { log, proxyActivities } from '@temporalio/workflow';
import { aggregateOffers, supplierNames } from '../domain/hotels';
import type { AggregationResult, SupplierBatch, SupplierFailure } from '../domain/hotels';
import type { SupplierActivities, WorkflowInput } from './contracts';

function isTimeout(error: unknown): boolean {
  if (error instanceof TimeoutFailure) return true;
  if (error instanceof ApplicationFailure && error.type === 'SUPPLIER_TIMEOUT') return true;
  return error instanceof Error && 'cause' in error ? isTimeout(error.cause) : false;
}

export async function hotelAggregationWorkflow(input: WorkflowInput): Promise<AggregationResult> {
  const { fetchSupplier } = proxyActivities<SupplierActivities>({
    startToCloseTimeout: input.settings.startToCloseMs,
    scheduleToCloseTimeout: input.settings.scheduleToCloseMs,
    retry: {
      maximumAttempts: input.settings.maximumAttempts,
      initialInterval: input.settings.retryInitialMs,
      maximumInterval: input.settings.retryMaxMs,
      backoffCoefficient: 2
    }
  });
  const results = await Promise.allSettled(supplierNames.map(supplier => fetchSupplier(supplier, input.city, input.requestId)));
  const batches: SupplierBatch[] = [];
  const failures: SupplierFailure[] = [];
  for (const [index, result] of results.entries()) {
    const supplier = supplierNames[index];
    if (!supplier) throw ApplicationFailure.nonRetryable('Invalid supplier configuration', 'INTERNAL_ERROR');
    if (result.status === 'fulfilled') batches.push(result.value);
    else failures.push({ supplier, reason: isTimeout(result.reason) ? 'timeout' : 'unavailable' });
  }
  const offers = aggregateOffers(batches);
  if (failures.length > 0) {
    log.warn('Supplier aggregation degraded', { city: input.city, requestId: input.requestId, failures });
    if (offers.length === 0) {
      const type = failures.some(failure => failure.reason === 'timeout') ? 'SUPPLIER_TIMEOUT' : 'SUPPLIER_UNAVAILABLE';
      throw ApplicationFailure.nonRetryable('Suppliers could not provide a usable dataset.', type);
    }
  }
  return { offers, failures };
}
