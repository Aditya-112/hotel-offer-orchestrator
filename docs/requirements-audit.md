# Requirement audit

This audit maps the detailed pasted brief to the implementation. The referenced assessment PDF was not attached, so its exact wording and any additional submission conditions remain unverified.

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| Node.js, strict TypeScript, Express | `package.json`, `tsconfig.json`, `src/app.ts` | Type checking, lint and production compilation pass |
| Temporal client, worker, workflow, activities | `src/temporal/` | Real Temporal integration suite and compiled-process smoke pass |
| Two independent mock suppliers | `src/suppliers/data.ts`, `src/app.ts` | HTTP contract tests and Postman requests |
| Supplier paths remain `/supplierA/hotels`, `/supplierB/hotels` | `src/app.ts` | API and integration tests |
| City-based supplier filtering | `src/app.ts` | Delhi, Mumbai and empty-city tests |
| Shared, unique, equal-price hotels; multiple cities; empty city | `src/suppliers/data.ts` | Delhi/Mumbai fixtures and Jaipur tests |
| Required city validation and normalization | `src/http/validation.ts` | Missing, empty, malformed, repeated, long and normalized city tests |
| Unknown city | Both suppliers return empty arrays | Real workflow returns and caches `[]` |
| Optional finite, nonnegative price bounds | `src/http/validation.ts` | Invalid strings, negative values, NaN/infinity, repeated bounds and valid decimals |
| Both bounds and reversed ranges | `src/http/validation.ts` | API and Postman assertions |
| Exact success array contract | `src/domain/hotels.ts`, `src/app.ts` | Unit, integration and Postman assertions |
| Parallel supplier activities | `src/temporal/workflows.ts` uses `Promise.allSettled` | Arrival-barrier integration test |
| HTTP happens only in activities | `src/temporal/activities.ts` | Real HTTP calls in integration and compiled worker smoke |
| Deterministic workflow | `src/temporal/workflows.ts` receives normalized city and settings | Worker bundles and executes workflow successfully |
| Configurable timeouts and bounded retries | `src/config/env.ts`, `src/temporal/client.ts`, `src/temporal/activities.ts` | Transient retry counts, exhaustion counts, HTTP and activity timeout tests |
| Workflow/API orchestration deadline | `src/temporal/client.ts` | Unpolled-queue timeout test and RPC deadline |
| Name-based deduplication | `src/domain/hotels.ts` | Case, whitespace, duplicates and nonfuzzy identity tests |
| Cheapest offer, correct commission and supplier | `src/domain/hotels.ts` | Both supplier winner cases and real Delhi response |
| Deterministic ties and sorting | `src/domain/hotels.ts` | Equal-price, reversed input and sorting tests |
| Preserve supplier-only hotels | `src/domain/hotels.ts` | Aggregation and full-flow assertions |
| Save deduplicated full dataset to Redis | `src/service.ts`, `src/redis/cache.ts` | Real hash and sorted-set contents inspected |
| Redis-side range filtering | `src/redis/cache.ts` uses Lua `ZRANGEBYSCORE` + `HGET` | Redis slow log includes those commands and excludes `HGETALL` |
| Inclusive boundaries; each bound alone; no matches | `src/redis/cache.ts` | Real Redis tests and collection assertions |
| First filtered request initializes full dataset | `src/service.ts` | Filtered-first tests assert full five-hotel Redis index |
| City isolation and stable record IDs | `src/redis/cache.ts` | City-specific keys and normalized-name members verified |
| Atomic replacement and atomic reads | `src/redis/cache.ts` | Concurrent replacement observations and stale-entry removal assertions |
| Expiry, empty cache and cache miss distinction | `src/redis/cache.ts` | Marker tests, identical server expiry deadlines, explicit expiry tests |
| Explicit Redis connectivity failures | `src/redis/cache.ts` | Disconnected Redis test returns `REDIS_UNAVAILABLE` |
| Partial supplier failures | `src/temporal/workflows.ts`, `src/service.ts` | Successful survivor, partial header and short cache TTL verified |
| Both suppliers fail | `src/temporal/workflows.ts` | 502 and no cache; 504 for stalled HTTP suppliers |
| Failed supplier plus empty survivor is not empty success | `src/temporal/workflows.ts` | Jaipur failure test returns 502 and no cache |
| Malformed supplier data | `src/temporal/activities.ts` | Nonretryable invalid-payload test |
| Central errors and suitable statuses | `src/http/errors.ts`, `src/app.ts` | Contract tests, secret/stack suppression test |
| Temporal unavailable | `src/temporal/client.ts` | Closed real connection test and missing-poller test |
| Missing worker produces controlled error | `src/temporal/client.ts` | Integration test and compiled-process smoke before/after worker |
| Health checks detect supplier outages | `src/http/health.ts` | Real HTTP probes verify healthy/degraded/unhealthy |
| Redis, Temporal namespace and worker health | `src/http/health.ts`, `src/temporal/worker.ts` | Healthy compiled stack and stopped-worker health verified |
| Structured logging and correlation IDs | `src/app.ts`, `src/service.ts`, `src/temporal/activities.ts` | Request ID tests; compiled process logs inspected |
| Graceful shutdown | `src/server.ts`, `src/temporal/worker.ts` | Compiled API and worker exit with status 0 after SIGTERM |
| Startup configuration validation | `src/config/env.ts` | Invalid ports, protocols, timeouts and TTL relationships tested |
| No comments, `any` types, suppressions or console.log application logging | `src/`, `tests/`, `scripts/` | Strict lint/type checking and source review |
| Multi-stage nonroot application image | `Dockerfile` | Image builds and container startup pass in GitHub Actions |
| Compose with API, worker, Redis, Temporal and persistence | `docker-compose.yml`, `docker/temporal.Dockerfile` | Compose validation, image builds, volume initialization and healthy startup pass in CI |
| Correct service DNS and readiness checks | `docker-compose.yml`, `scripts/healthcheck.mjs` | All four containers become healthy and the collection passes through the Docker stack |
| Writable nonroot Temporal volume | `docker/temporal.Dockerfile` | Temporal initializes its persisted database and reaches healthy status in CI |
| Complete Docker startup with no manual initialization | `docker-compose.yml` | `docker compose up --build --wait --wait-timeout 180` passes on the Linux CI runner |
| Environment example and ignored secrets | `.env.example`, `.gitignore`, `.dockerignore` | Submission file inspection |
| Automated unit and real integration tests | `tests/unit/`, `tests/integration/` | 53 unit/API tests and 24 integration tests pass |
| Separate compiled-process end-to-end check | `scripts/smoke.mjs` | API → worker → suppliers → Redis → response and shutdown pass |
| Postman deliverable | `postman/hotel-offer-orchestrator.postman_collection.json` | Official v2.1 schema; 15 requests and 33 live assertions pass |
| README setup, API, failure, cache, deployment, troubleshooting | `README.md` | Reviewed against implemented behavior |
| CI verification including Docker | `.github/workflows/ci.yml` | [Successful observed run](https://github.com/Aditya-112/hotel-offer-orchestrator/actions/runs/45038411486) |
| Exact PDF compliance and submission conditions | PDF not supplied | Pending receipt of source PDF |

## Submission checklist

- [x] Application, tests, environment example, container definitions, Postman collection and README exist.
- [x] Strict TypeScript, lint, unit/API tests, real integration tests and production build pass locally.
- [x] Compiled API and worker run separately and satisfy all collection assertions.
- [x] Redis server-side range filtering is confirmed by Redis command evidence.
- [x] Temporal concurrency, retries, timeouts and failure policies are exercised.
- [x] Generated dependencies, build output, local tools and environment secrets are excluded from Git.
- [x] Run Docker image builds and the complete Compose stack on a Docker-enabled machine or CI.
- [ ] Obtain and audit the assessment PDF.
- [x] Confirm the remote push and observe the GitHub Actions result.
