import type { AggregationResult, SupplierBatch, SupplierName } from '../domain/hotels';

export type WorkflowSettings = {
  startToCloseMs: number;
  scheduleToCloseMs: number;
  maximumAttempts: number;
  retryInitialMs: number;
  retryMaxMs: number;
};

export type WorkflowInput = { city: string; settings: WorkflowSettings; requestId: string };
export type SupplierActivities = {
  fetchSupplier(supplier: SupplierName, city: string, requestId: string): Promise<SupplierBatch>;
};
export type HotelWorkflow = (input: WorkflowInput) => Promise<AggregationResult>;
