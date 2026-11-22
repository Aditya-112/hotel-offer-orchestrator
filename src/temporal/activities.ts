import { ApplicationFailure } from '@temporalio/common';
import { Context } from '@temporalio/activity';
import { z } from 'zod';
import type { Logger } from 'pino';
import type { Config } from '../config/env';
import { supplierOfferSchema } from '../domain/hotels';
import type { SupplierActivities } from './contracts';

export function createSupplierActivities(config: Config, logger: Logger): SupplierActivities {
  return {
    async fetchSupplier(supplier, city, requestId) {
      const url = new URL(supplier === 'Supplier A' ? config.SUPPLIER_A_URL : config.SUPPLIER_B_URL);
      url.searchParams.set('city', city);
      const timeout = AbortSignal.timeout(config.SUPPLIER_HTTP_TIMEOUT_MS);
      const signal = AbortSignal.any([timeout, Context.current().cancellationSignal]);
      logger.info({ supplier, city, requestId, attempt: Context.current().info.attempt }, 'Fetching supplier offers');
      try {
        const response = await fetch(url, { signal, headers: { 'x-request-id': requestId } });
        if (!response.ok) {
          await response.body?.cancel();
          throw ApplicationFailure.create({
            message: 'Supplier request failed.', type: 'SUPPLIER_UNAVAILABLE',
            nonRetryable: response.status < 500 && response.status !== 429
          });
        }
        const payload: unknown = await response.json();
        const parsed = z.array(supplierOfferSchema).max(10000).safeParse(payload);
        if (!parsed.success || parsed.data.some(offer => offer.city.trim().toLowerCase() !== city)) {
          throw ApplicationFailure.nonRetryable('Supplier returned an invalid dataset.', 'SUPPLIER_INVALID_RESPONSE');
        }
        return { supplier, offers: parsed.data };
      } catch (error) {
        if (error instanceof ApplicationFailure) throw error;
        if (Context.current().cancellationSignal.aborted) throw error;
        throw ApplicationFailure.create({
          message: timeout.aborted ? 'Supplier request timed out.' : 'Supplier is unavailable.',
          type: timeout.aborted ? 'SUPPLIER_TIMEOUT' : 'SUPPLIER_UNAVAILABLE'
        });
      }
    }
  };
}
