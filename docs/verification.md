# Verification record

Executed on 22 November 2026. Results below distinguish local runs from the observed Docker-enabled GitHub Actions run.

## Environment

| Component | Version |
| --- | --- |
| Node.js | 24.5.0 |
| TypeScript | 5.9.3 |
| Temporal TypeScript SDK | 1.26.0 |
| Temporal CLI | 1.10.1 |
| Temporal embedded server | 1.32.2 |
| Redis test binary | 7.4.7, built locally from official source |
| Vitest | 4.1.12 |
| Standalone Compose validator | 5.8.0, official release checksum verified |

## Results

| Check | Observed result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm test` | 53 tests passed across 3 files |
| `npm run test:integration` | 24 tests passed against real ephemeral Redis, Temporal and HTTP suppliers |
| `npm run build` | Passed |
| `npm run postman:validate` | Official Postman v2.1 schema accepted all 15 requests |
| `npm run test:process` | Compiled API and worker passed end-to-end, health, missing-worker, cache and graceful-shutdown checks |
| Collection run inside process smoke | 15 HTTP requests and 33 assertions passed |
| `npm audit --omit=dev` | 0 vulnerabilities reported |
| `npm audit` | 0 vulnerabilities reported |
| Compose `config --quiet` | Passed using official standalone Compose CLI |
| Container tags | Upstream Temporal 1.10.1 and Redis 7.4.7-alpine confirmed available |
| Compose build attempt | Blocked: Docker engine socket `/var/run/docker.sock` does not exist |
| Local container startup | Not executed; Docker engine is unavailable on the desktop |
| Hosted Docker image builds | Passed in GitHub Actions |
| Hosted complete Compose startup | Passed; API, worker, Redis and Temporal reached healthy status |
| Hosted Postman collection against Docker stack | All 15 requests and 33 assertions passed |
| Hosted verification workflow | Passed for code commit `505339906802cac532dd7581696b26a4c3258660` |
| Docker Hub publication | Both public images published for Linux AMD64 and ARM64 |
| Fresh registry-pull verification | All four containers healthy; 15 requests and 33 assertions passed |

The [successful GitHub Actions run](https://github.com/Aditya-112/hotel-offer-orchestrator/actions/runs/45038411486) reran static checks, all 77 unit/integration tests, Compose validation, image builds, readiness-aware stack startup and the live collection. The initial CI run built the images but encountered a host port conflict with the runner's installed Redis service. CI now maps Redis to host port 16379, while all containers continue using `redis:6379`.

## Docker Hub publication

The [publication and registry-pull verification run](https://github.com/Aditya-112/hotel-offer-orchestrator/actions/runs/45041514869) completed successfully for source commit `f19f88e3713f4daa4ee57ec9dedc624f480fe13d`. It reran the full verification workflow before publishing both images and then tested a fresh stack using the public registry images with builds disabled.

| Public image | Manifest digest |
| --- | --- |
| [aditya40hehe/hotel-offer-orchestrator](https://hub.docker.com/r/aditya40hehe/hotel-offer-orchestrator) | `sha256:2efc3551ca14689973300927a354a5799a9563031a40be7693273799275d554e` |
| [aditya40hehe/hotel-offer-orchestrator-temporal](https://hub.docker.com/r/aditya40hehe/hotel-offer-orchestrator-temporal) | `sha256:87ae85247e5249126060c19d0b3ca19bcb093989649575fb7aaaea618984f16b` |

Both public registry manifests include `linux/amd64` and `linux/arm64`. Their `latest` and `sha-f19f88e3713f4daa4ee57ec9dedc624f480fe13d` tags were confirmed to resolve to matching digests. The application image is used for both API and worker roles. Redis remains the official `redis:7.4.7-alpine` image.

The `verify-published` job pulled these commit-specific images anonymously, used `docker-compose.hub.yml` with `--no-build`, waited for all four services to become healthy and passed the complete live collection. This runtime verification used Linux AMD64; native ARM64 container execution remains untested. No access tokens are stored in the source repository or Docker build context.

Local reproduction with the ignored test binary:

```bash
npm run check
REDIS_SERVER_PATH="$PWD/.local/redis-7.4.7/src/redis-server" npm run test:integration
REDIS_SERVER_PATH="$PWD/.local/redis-7.4.7/src/redis-server" npm run test:process
```

On other machines install `redis-server` or point `REDIS_SERVER_PATH` to a local binary. The `.local` tools directory is intentionally excluded from the repository and image context.

## Evidence of the central requirements

The full-flow integration test sends an Express request through a real Temporal worker, both real supplier HTTP endpoints, the pure aggregator and real Redis. It checks the exact winning offers and stored price scores. A first filtered request still leaves all five deduplicated Delhi records in Redis.

The parallelism test holds supplier requests at an arrival barrier until both have arrived. Sequential orchestration cannot satisfy that barrier before the HTTP timeout.

The Redis test enables the isolated server's slow log, performs a 5340–5340 query and checks that `ZRANGEBYSCORE` and `HGET` executed on the server, with no `HGETALL`. Only the Holtin record is returned. Other tests verify inclusive bounds, one-sided ranges, no matches, city isolation and atomic replacements.

Retry tests inspect actual HTTP call counts: transient A failure produces two A attempts and one B attempt; exhausted A failure produces three A attempts and one B attempt; two unavailable suppliers produce three attempts each and a 502. Stalled HTTP suppliers return 504 after bounded retries. A separate test exercises Temporal's own activity timeout. A closed Temporal connection and an unpolled queue return controlled orchestration errors.

The compiled-process smoke starts `dist/server.js` and `dist/temporal/worker.js` independently. Before worker startup a cache miss returns `WORKER_UNAVAILABLE`. With the worker running, dependency health is healthy and all collection requests/assertions pass. After worker shutdown health returns 503, a new city returns 503, and the cached Delhi result remains available. Both application processes exit with status 0 on SIGTERM.

Application process logs are checked for uncaught startup errors and unhandled rejections. The SDK emitted an upstream `fs.F_OK` deprecation warning. One ephemeral Temporal startup emitted transient `shard status unknown` messages before readiness; its subsequent workflow and integration checks passed. These are not reported as application test failures or hidden as successful container validation.

## Remaining verification and limits

- Docker image builds, initialized volume ownership, container health checks and complete Compose startup were verified on the Linux GitHub runner. Desktop Docker execution and native ARM64 container execution were not performed; the desktop has no Docker engine.
- The assessment PDF was not supplied. The implementation and audit cover the detailed pasted brief; exact PDF-only requirements remain unknown.
- The Postman collection was schema-validated and its own assertions were executed against the live API through the included adapter. No interactive Postman GUI import was claimed.
- The project was pushed to [Aditya-112/hotel-offer-orchestrator](https://github.com/Aditya-112/hotel-offer-orchestrator), and the linked code verification run completed successfully. Subsequent documentation-only updates do not change the tested application.
