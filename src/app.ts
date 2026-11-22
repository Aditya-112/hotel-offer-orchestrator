import { randomUUID } from 'node:crypto';
import express from 'express';
import type { ErrorRequestHandler } from 'express';
import type { Logger } from 'pino';
import type { Config } from './config/env';
import { AppError } from './http/errors';
import type { HealthReport } from './http/health';
import { parseCity, parseHotelQuery } from './http/validation';
import type { FindHotels } from './service';
import { supplierData } from './suppliers/data';
import type { SupplierName } from './domain/hotels';

type Dependencies = {
  config: Config;
  logger: Logger;
  findHotels: FindHotels;
  health: () => Promise<HealthReport>;
};

export function createApp({ config, logger, findHotels, health }: Dependencies) {
  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple');
  app.use((request, response, next) => {
    const incomingId = request.get('x-request-id');
    const requestId = incomingId && /^[a-zA-Z0-9_-]{1,80}$/.test(incomingId) ? incomingId : randomUUID();
    response.setHeader('x-request-id', requestId);
    const started = performance.now();
    response.on('finish', () => logger.info({ requestId, method: request.method, path: request.path, status: response.statusCode, durationMs: Math.round(performance.now() - started) }, 'HTTP request'));
    next();
  });
  app.get('/live', (_request, response) => response.json({ status: 'alive' }));
  app.get('/health', async (_request, response) => {
    const report = await health();
    response.status(report.status === 'unhealthy' ? 503 : 200).json(report);
  });
  app.get('/api/hotels', async (request, response) => {
    const query = parseHotelQuery(request.query);
    const requestId = String(response.getHeader('x-request-id'));
    const result = await findHotels(query, requestId);
    if (result.partial) response.setHeader('x-hotel-data-status', 'partial');
    response.json(result.offers);
  });
  const supplierRoute = (supplier: SupplierName, mode: Config['SUPPLIER_A_MODE']) => {
    app.get(supplier === 'Supplier A' ? '/supplierA/hotels' : '/supplierB/hotels', (request, response) => {
      const city = request.query.city === undefined ? undefined : parseCity(request.query.city);
      if (mode === 'unavailable') throw new AppError(503, 'SUPPLIER_UNAVAILABLE', 'Mock supplier is unavailable.');
      if (mode === 'timeout') {
        const timer = setTimeout(() => response.status(504).json({ error: { code: 'SUPPLIER_TIMEOUT', message: 'Mock supplier timed out.' } }), config.SUPPLIER_HTTP_TIMEOUT_MS * 2);
        response.on('close', () => clearTimeout(timer));
        return;
      }
      response.json(supplierData[supplier].filter(offer => city === undefined || offer.city === city));
    });
  };
  supplierRoute('Supplier A', config.SUPPLIER_A_MODE);
  supplierRoute('Supplier B', config.SUPPLIER_B_MODE);
  app.use((_request, _response, next) => next(new AppError(404, 'NOT_FOUND', 'Endpoint not found.')));
  const errors: ErrorRequestHandler = (error: unknown, _request, response, next) => {
    if (response.headersSent) { next(error); return; }
    const requestId = String(response.getHeader('x-request-id'));
    const known = error instanceof AppError;
    const failure = known ? error : new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred.');
    logger.error({ requestId, code: failure.code, errorName: error instanceof Error ? error.name : 'UnknownError' }, 'Request failed');
    response.status(failure.status).json({ error: { code: failure.code, message: failure.message, requestId } });
  };
  app.use(errors);
  return app;
}
