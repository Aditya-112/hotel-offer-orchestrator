# Hotel Offer Orchestrator

A TypeScript backend that uses Temporal to fetch two hotel suppliers concurrently, selects the cheapest offer for each hotel name, and stores the selected dataset in Redis. Price ranges are selected by Redis, including on the first request for a city.

## Run with Docker

Prerequisites: Docker Engine or Docker Desktop with Compose v2. Node.js 24 is needed only for local development and the test tools.

```bash
docker compose up --build
```

For a readiness-aware background startup:

```bash
docker compose up --build --wait --wait-timeout 180
curl http://localhost:3000/health
```

API: `http://localhost:3000`. Temporal UI: `http://localhost:8233`. The default stack requires no credentials, schema setup, or manual worker launch. Redis and Temporal have named volumes. `docker compose down` preserves them; `docker compose down --volumes` deletes the local stack's stored state.

Compose waits for Redis and Temporal health checks. The API connects to both before listening. The worker starts independently of the API's full dependency health to avoid a readiness cycle. Cache misses check worker readiness and return a controlled 503 while it starts. `/health` becomes healthy after the worker is running and both suppliers respond. A small Temporal image extension creates its persistent data directory with the nonroot service user's ownership before Docker initializes the volume.

## Request flow

```text
GET /api/hotels
  → validate and normalize city and bounds
  → Redis range lookup
  → on cache miss, execute Temporal workflow
      → Supplier A activity ─┐
      → Supplier B activity ─┴─ concurrently over HTTP
      → select cheapest offer per normalized name
  → atomically replace the city's Redis dataset
  → Redis ZRANGEBYSCORE + HGET for matching records
  → exact offer array
```

Express handles transport, validation, correlation IDs and errors. The Temporal client submits workflows to the configured task queue; a separate worker executes them. Activities own all supplier HTTP requests. The workflow receives its retry settings as input and performs deterministic coordination and aggregation. Redis is the only application datastore.

Temporal makes each supplier attempt observable and durable, with independent retries and bounded activity execution. Redis sorted sets index hotel IDs by price, so range selection happens on the server without loading every hotel into Node.js.

## API

| Endpoint | Behavior |
| --- | --- |
| `GET /api/hotels?city=delhi` | Cheapest unique offers, sorted by price and normalized name |
| `GET /api/hotels?city=delhi&minPrice=5000&maxPrice=6000` | Inclusive price range |
| `GET /supplierA/hotels?city=delhi` | Supplier A's independent mock dataset |
| `GET /supplierB/hotels?city=delhi` | Supplier B's independent mock dataset |
| `GET /health` | API, both suppliers, Redis, Temporal namespace and worker status |
| `GET /live` | Lightweight process liveness |

Supplier city parameters are optional; without one they return their own complete dataset. Hotel aggregation requires a city. Delhi and Mumbai contain hotels. Jaipur is a valid empty city. Other syntactically valid city names also return `[]`. City names are trimmed, whitespace normalized, and lowercased; names must start with a Unicode letter and contain only letters, spaces, apostrophes, periods or hyphens, up to 80 characters.

Price bounds are optional finite nonnegative decimals. Bounds are inclusive; either can be supplied alone. Repeated parameters, empty bounds, negative values, hexadecimal notation, `NaN` and infinity are rejected. A minimum above the maximum returns 400.

```bash
curl 'http://localhost:3000/api/hotels?city=delhi'
curl 'http://localhost:3000/api/hotels?city=delhi&minPrice=5000&maxPrice=6000'
curl 'http://localhost:3000/api/hotels?city=delhi&minPrice=6000'
curl 'http://localhost:3000/api/hotels?city=delhi&maxPrice=4500'
curl 'http://localhost:3000/api/hotels?city=jaipur'
```

The 5000–6000 request returns exactly:

```json
[
  { "name": "Holtin", "price": 5340, "supplier": "Supplier B", "commissionPct": 20 },
  { "name": "Radison", "price": 5900, "supplier": "Supplier A", "commissionPct": 13 }
]
```

The complete Delhi response also includes Lotus Residency at 3800 from B, City Garden at 4500 from A, and The Imperial at 12500 from A. There is no success wrapper or metadata. Every response includes `x-request-id`; valid incoming IDs are propagated to supplier activities and logs. Partial responses add `x-hotel-data-status: partial` without changing the array contract.

## Comparison rules

Hotel identity is the trimmed, lowercased name. Internal spaces and punctuation are preserved; no fuzzy matching is performed. Lowest price wins, irrespective of commission. Equal prices favor Supplier A, then the ordinal display name, then the smaller commission for otherwise identical same-supplier duplicates. These final tie rules make output independent of input ordering. The selected offer retains its trimmed display name, price, supplier and commission. Supplier-only hotels remain in the result. Output sorts by price, then normalized name using ordinal comparison rather than locale-dependent ordering.

Supplier HTTP payloads are validated as a whole, including city, nonnegative finite price and commission in 0–100. Invalid payloads are nonretryable supplier failures. The pure aggregation function also excludes invalid individual offers when called directly.

## Redis cache and filtering

Each encoded city has three keys sharing a Redis hash tag:

```text
hotels:{delhi}:prices    sorted set: normalized hotel name → price
hotels:{delhi}:offers    hash: normalized hotel name → complete offer JSON
hotels:{delhi}:ready     complete or partial dataset marker
```

One Lua script deletes the prior dataset and writes the replacement, index, marker and matching expiry deadlines. Readers cannot see interleaved writes. Replacements remove stale hotels. Empty cities have a marker even though Redis omits empty hashes and sorted sets; a marker distinguishes empty results from a miss.

A second Lua script checks the marker, executes `ZRANGEBYSCORE` with inclusive bounds and loads only matching hash records through `HGET`. The selection and hydration share the same atomic read, preventing a refresh from mixing versions. Node.js validates and sorts the returned matches; it does not perform price filtering. No request uses the Redis `KEYS` command.

Complete results expire after 60 seconds by default; partial results after 10 seconds. Expiry is the refresh mechanism. Requests within that interval use the cached dataset, including filtered requests and empty cities. A first filtered request fetches and stores the full deduplicated city dataset before querying Redis for its range. Concurrent cache misses for one city share a refresh within the API process. Multiple replicas can refresh independently; the last completed refresh wins. There is no stale-data fallback on Redis errors.

To invalidate Delhi manually during local testing:

```bash
docker compose exec redis redis-cli DEL 'hotels:{delhi}:prices' 'hotels:{delhi}:offers' 'hotels:{delhi}:ready'
```

## Timeouts, retries and failures

Defaults: supplier HTTP timeout 1500 ms, activity start-to-close 3000 ms, activity schedule-to-close 12000 ms, workflow deadline 20000 ms. Each supplier gets at most three attempts, with 250 ms exponential initial delay capped at 1000 ms. HTTP requests do not have another retry layer. Workflow retries are not enabled. The activity total timeout bounds queue delays and retries; the workflow and client RPC deadlines bound orchestration. Startup validation checks timeout relationships.

Activities run concurrently using `Promise.allSettled`. A failed supplier does not discard valid offers from the other supplier. If any usable offers remain, the result is returned and cached briefly as partial. If both suppliers fail, or the sole successful supplier is empty, the workflow fails and nothing is cached. A genuine outage is never represented as a successful empty dataset.

| Status | Codes |
| --- | --- |
| 400 | `INVALID_CITY`, `INVALID_MIN_PRICE`, `INVALID_MAX_PRICE`, `INVALID_PRICE_RANGE` |
| 502 | `SUPPLIER_UNAVAILABLE` |
| 504 | `SUPPLIER_TIMEOUT` when no usable dataset remains |
| 503 | `REDIS_UNAVAILABLE`, `TEMPORAL_UNAVAILABLE`, `WORKER_UNAVAILABLE` |
| 500 | `INTERNAL_ERROR` |

Errors have `{ "error": { "code", "message", "requestId" } }`. Responses do not expose stack traces, credentials or dependency addresses. Pino emits structured request, cache and activity logs. SDK worker logs use the same logger. API shutdown drains requests before closing clients; Temporal handles worker signals and drains activities with a bounded grace period.

## Health and controlled failure exercises

`/health` probes real supplier HTTP endpoints, Redis `PING`, the Temporal namespace, and worker readiness concurrently with short deadlines. It reports `healthy` with 200 when all pass; `degraded` with 200 when one supplier fails and core dependencies work; `unhealthy` with 503 when both suppliers or any core dependency fail. `/live` only checks the API process. Health checks reveal no infrastructure addresses.

Failure modes are environment-driven and have no public toggle endpoint:

```bash
SUPPLIER_A_MODE=unavailable docker compose up -d --force-recreate api
curl 'http://localhost:3000/api/hotels?city=mumbai'
curl http://localhost:3000/health
```

Use an uncached city or invalidate its cache first; fresh complete caches intentionally retain their offers until expiry. `timeout` simulates a stalled supplier; `healthy` restores it. Set both modes to `unavailable` to exercise a 502 after retry exhaustion. After an exercise, recreate the API with healthy modes and invalidate partial caches or wait for their short TTL.

## Environment and local development

All settings and defaults are in `.env.example` and `src/config/env.ts`. No secrets are required for the assessment. Compose reads `.env` automatically and supplies container network addresses explicitly, so localhost development values cannot break container routing. Host port overrides are `API_PORT`, `REDIS_PORT`, `TEMPORAL_PORT`, `TEMPORAL_UI_PORT`. Application `PORT` remains 3000 inside Compose. The namespace is `default` in Compose; the task queue and timing settings are configurable.

For local Node.js development with containerized dependencies:

```bash
npm ci
cp .env.example .env
docker compose up -d redis temporal
node --env-file=.env --import tsx src/server.ts
```

In another terminal:

```bash
node --env-file=.env --import tsx src/temporal/worker.ts
```

`npm run dev` and `npm run dev:worker` use watch mode and defaults; export environment overrides in those terminals if needed. Without Docker, run a local Redis server and `temporal server start-dev` instead. Local application processes load `.env` only when explicitly passed `--env-file`.

## Verification

```bash
npm run check
npm run test:integration
npm run test:process
npm run postman:test
```

`check` runs strict type checking, lint, unit/API tests, production compilation, and Postman schema validation. Integration tests require a `redis-server` executable on PATH and network access for the Temporal SDK's first CLI download. They start isolated ephemeral Redis and Temporal instances, use actual HTTP supplier activities, and shut them down afterward. Set `REDIS_SERVER_PATH` or `TEMPORAL_CLI_PATH` to existing binaries if necessary. They do not flush a shared external Redis instance.

The integration suite checks the complete flow, concurrency with an arrival barrier, cheapest winners, city isolation, bounded retries, HTTP and activity timeouts, partial and total failures, malformed suppliers, atomic replacement, marker semantics and shared expiry deadlines. Expiry is triggered through Redis server commands rather than sleeps. A real Redis slow log proves that range reads execute `ZRANGEBYSCORE` and `HGET`, without `HGETALL`.

Import `postman/hotel-offer-orchestrator.postman_collection.json` into Postman and set `baseUrl`. Run it against the healthy default stack. It includes 15 requests and checks status, exact shape, winning offers, deduplication, ranges and dependency health. `postman:validate` uses the vendored official v2.1 schema. `postman:test` executes this collection's HTTP requests and assertion scripts using Chai and a restricted `pm` adapter; it is a focused runner for this collection, not a complete Postman runtime.

`test:process` builds the application, starts its compiled API and worker as separate Node processes against real ephemeral Redis and Temporal, and runs all collection assertions. It also checks missing-worker responses, dependency health, cached availability while the worker is stopped, and graceful SIGTERM. It needs the same local binaries as integration tests.

GitHub Actions runs checks, real integration tests, builds and starts Compose, then runs the collection. The [observed verification run](https://github.com/Aditya-112/hotel-offer-orchestrator/actions/runs/45038411486) passed all checks, including Docker readiness and collection assertions. Local and hosted validation results and the requirement audit are recorded in `docs/verification.md` and `docs/requirements-audit.md`.

## Deployment and troubleshooting

Build the shared image with `docker build -t hotel-offer-orchestrator .`. Run `node dist/server.js` and `node dist/temporal/worker.js` as separate processes using the same task queue, namespace and supplier endpoints. The image runs as the nonroot `node` user. Configure service DNS addresses through environment variables. The worker's internal readiness port must be reachable by the API.

The included [Temporal CLI server](https://docs.temporal.io/cli/setup-cli) with volume-backed embedded SQLite is intended for this local assessment. It needs no separate persistence service. A production deployment should use a supported managed or self-hosted Temporal deployment, managed Redis, TLS and secret injection, plus application limits appropriate to traffic. This repository does not provision that infrastructure or implement Temporal Cloud authentication. The mock suppliers remain local deterministic data, and all prices use one assumed currency and no conversion.

| Symptom | Check |
| --- | --- |
| `docker` command missing | Install/start Docker Desktop or Docker Engine with Compose v2 |
| Port already allocated | Set the appropriate host port in `.env`; update the client base URL |
| Worker not ready | Inspect `docker compose logs worker temporal`; verify identical namespace/task queue and `temporal:7233` routing |
| API 503 | Inspect `/health` and `docker compose logs api`; verify Redis, Temporal and worker readiness |
| Supplier failure mode seems ineffective | Invalidate the city cache or wait for expiry |
| Redis failure | Check `docker compose exec redis redis-cli ping`, memory, volume permissions and service logs |
| Temporal startup failure | Check its volume permissions and logs; the dev server must bind `0.0.0.0` in containers |
| Integration binary unavailable | Install Redis or set `REDIS_SERVER_PATH`; set `TEMPORAL_CLI_PATH` for offline tests |

Reasonable future improvements are distributed refresh coalescing for multiple API replicas, supplier payload size limits, pagination for large city datasets, metrics and authenticated production dependency connections. They are deliberately outside this assessment's scope.

## Layout

```text
src/
  app.ts, server.ts, service.ts
  config/env.ts
  domain/hotels.ts
  http/errors.ts, health.ts, validation.ts
  redis/cache.ts
  suppliers/data.ts
  temporal/activities.ts, client.ts, contracts.ts, worker.ts, workflows.ts
tests/
  unit/aggregation.test.ts, api.test.ts, service.test.ts
  integration/system.test.ts
postman/
scripts/
docs/
Dockerfile
docker-compose.yml
.env.example
```
