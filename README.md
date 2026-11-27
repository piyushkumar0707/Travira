# Travira

Travira is a tourism safety dashboard and API prototype. It contains a React web frontend, a Node/Express API, two FastAPI services, and MongoDB persistence. The repository also includes a separate blockchain integration; the Compose setup below does not start it.

## Architecture

```mermaid
flowchart LR
  Browser[React web app] -->|HTTP + Socket.IO, JWT| API[Node / Express API]
  API --> DB[(MongoDB)]
  API -->|Bearer JWT| Score[FastAPI safety score]
  API -->|Bearer JWT| Report[FastAPI case report]
  API -. optional, separate setup .-> Chain[Blockchain API]
```

### Location update flow

1. An authenticated client posts coordinates to `POST /api/mobile/location/update`.
2. The Node API validates and stores the location, checks configured geofences, and calls the safety-score service with the caller's JWT.
3. When a score is returned successfully, the API stores it and emits a Socket.IO event to authenticated admin and officer connections. Configured email notifications may be sent for geofence breaches.

The included mobile routes are backend endpoints. This repository does not contain a native mobile application. Email, FCM, AI services, and blockchain integrations require their respective configuration and are not always available in a local run.

## Services

| Component | Responsibility | Local address |
| --- | --- | --- |
| Frontend | React/Vite browser dashboard | http://localhost:3000 |
| Backend | Express API, JWT auth, MongoDB persistence, Socket.IO | http://localhost:5000 |
| Safety score | FastAPI model inference | http://localhost:8001 |
| Case report | FastAPI PDF generation | http://localhost:8002 |
| MongoDB | Application data | Internal Compose network |

## Run with Docker Compose

Prerequisites: Docker Desktop with Compose v2. The Compose stack starts MongoDB, the backend, both FastAPI services, and the frontend. It does not start the blockchain service.

```powershell
Copy-Item .env.example .env
# Edit .env and replace JWT_SECRET with a random secret of at least 32 characters.
docker compose up --build
```

Use the same `JWT_SECRET` for the backend and both FastAPI services. The backend API is at `http://localhost:5000`; the web app is at `http://localhost:3000`. Stop the stack with `docker compose down`. Add `-v` only if you intend to delete the local MongoDB volume and its data.

The demo database can be populated with `docker compose exec backend node seed.js`. **The seed script deletes existing tourist, incident, and geofence records and selected demo users before inserting sample data.** Use it only with disposable data.

## Run services manually

Install dependencies with `npm install`, `npm --prefix backend install`, `npm --prefix frontend install`, and install each Python `requirements.txt`. Set `MONGODB_URI`, `JWT_SECRET`, and the AI service URLs in the environment before starting the backend. Set the same `JWT_SECRET` in the environments for both FastAPI services. For the frontend, set `VITE_API_BASE_URL=http://localhost:5000`.

From the repository root, start each process in its own terminal:

```powershell
npm run dev
npm run backend
npm run ai:safety
npm run ai:case
```

The Python commands require the matching service requirements to be installed. The `backend` command loads the root `.env` through `dotenv`. The Python processes inherit environment variables from the shell; `.env` is not loaded automatically by Uvicorn.

## Authentication and request behavior

- `POST /api/login`, `POST /api/register`, `POST /api/mobile/auth/login`, and `GET /api/health` are public. Other `/api` routes require a signed `Bearer` JWT.
- Public registration creates tourist accounts only. An authenticated admin can create other roles through the same endpoint.
- Admins and officers only: listing tourists, changing safety scores, updating incidents, blockchain logs, and every `/api/ai/*` route.
- Admins, officers, or the tourist concerned: reading one tourist record and generating an incident report.
- Both login routes allow 10 failed attempts per account and 100 per network address in 15 minutes, then answer `429` with `Retry-After`. Successful logins are not counted. Behind a hosting proxy, set `TRUST_PROXY_HOPS` (usually `1`) so each visitor is counted by their own address.
- Each user can set an emergency contact 5 times per hour; removing it is always allowed. Contact addresses are not verified.
- Panic alerts are never rate limited: each one is recorded and sent to staff. Only the email to the same contact is capped, at 3 per 10 minutes, and failed sends do not count. The response's `contactEmail` is `sending`, `recently_sent`, or `no_contact`.
- Rate-limit counts are held in memory, so they reset on restart and are not shared between backend instances.
- Socket.IO requires the JWT in the handshake `auth.token`; the server sends location and incident events to authenticated admin and officer sockets.
- The safety-score `/calculate` and case-report `/report` endpoints require a valid JWT signed with the same `JWT_SECRET`.
- Error responses use an `error` message and a stable `code`. Validation errors may include field details.
- Express JSON request bodies are limited to 1 MB. Location, score, incident, and report inputs have basic type and range checks.

See [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md) for service boundaries, trade-offs, and known scaling limits.

## Checks currently available

- `npm --prefix frontend run build` builds the web frontend.
- `npm --prefix backend run test:all` runs backend integration and concurrent score-history regression tests against a disposable MongoDB; the integration suite also needs both FastAPI services running.
- `python -m pytest -q test_api_integration.py` in each `AI_services` directory runs that FastAPI service's auth and validation suite (install `pytest` and `httpx` first).
- GitHub Actions runs all three suites on push. The frontend `test` script remains a placeholder, not a test suite.

## Benchmarks

The benchmark is **API-level, local Compose**. It repeatedly exercises authenticated location updates through the Node API, MongoDB persistence, geofence evaluation, and the safety-score service. It does not measure WebSocket delivery or a deployed environment. Each request rotates among the supplied accounts.

```powershell
# Create at least 20 distinct tourist accounts in the Compose database first.
$env:BENCH_USERNAMES = (1..20 | ForEach-Object { 'tourist_{0:D2}' -f $_ }) -join ','
$env:BENCH_PASSWORD = 'the-shared-test-account-password'
npm run bench:matrix
```

The matrix runs concurrency 1, 5, 10, and 30 three times each for 30 seconds per run. The location-update command supports a single `BENCH_USERNAME` or a comma-separated `BENCH_USERNAMES` list; the matrix command requires at least 20 distinct names. Raw per-run JSON is saved under `benchmarks/`.

### Measured results: API-level, local Compose

Measured on 2026-11-09 from a Windows_NT 10.0.26300 x64 client (Node v22.19.0, 16 logical CPU cores, 16372613120 bytes RAM), against one local Compose backend instance. Docker Engine 28.5.1 reported 16 CPUs and 7927427072 bytes; backend Node v20.20.2; both FastAPI services 0.162.2; scikit-learn 1.9.1; ReportLab 5.1.0. Twenty distinct tourist accounts were used in every run; the disposable database had no geofences. Percentiles use successful responses only. No deployed run was performed.

| Concurrency | Run | Requests | Errors | Success rate | p50 (ms) | p95 (ms) | p99 (ms) | Successful req/s |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1 | 523 | 0 | 100% | 56.6977999999981 | 61.5317 | 74.8804999999993 | 17.40645787841212 |
| 1 | 2 | 512 | 0 | 100% | 56.98980000000029 | 69.8393000000001 | 81.50430000000051 | 17.03923599580137 |
| 1 | 3 | 524 | 0 | 100% | 56.03059999999823 | 64.90509999999995 | 81.57359999999971 | 17.441607263015456 |
| 5 | 1 | 702 | 0 | 100% | 211.52440000000206 | 263.9419999999991 | 308.5473000000002 | 23.239455489361657 |
| 5 | 2 | 689 | 0 | 100% | 217.01889999999912 | 270.78689999999915 | 305.83000000000175 | 22.861320103338077 |
| 5 | 3 | 691 | 0 | 100% | 214.95659999999998 | 269.3617000000013 | 298.8110000000015 | 22.976446943990744 |
| 10 | 1 | 684 | 0 | 100% | 440.7714999999989 | 540.7574999999997 | 603.4361000000026 | 22.57497058619951 |
| 10 | 2 | 690 | 0 | 100% | 436.813299999998 | 536.5499999999993 | 601.3221000000012 | 22.730006467246856 |
| 10 | 3 | 683 | 0 | 100% | 441.3152999999984 | 551.6358 | 593.962300000001 | 22.587110731071487 |
| 30 | 1 | 688 | 0 | 100% | 1355.6654999999992 | 1749.335000000001 | 1938.8741 | 22.629230494760264 |
| 30 | 2 | 694 | 0 | 100% | 1347.003 | 1650.4972000000016 | 1849.4457000000002 | 22.604253430642494 |
| 30 | 3 | 684 | 0 | 100% | 1380.7879000000003 | 1764.7122000000018 | 1909.8804000000018 | 22.242312276445254 |

Raw output for every run: [results-local-compose-2026-11-09.json](benchmarks/results-local-compose-2026-11-09.json). These 2026-11-09 runs predate the single-thread inference change below.

### Before and after: single-threaded model inference

The saved Random Forest has `n_jobs=-1`, so each prediction was split across all CPU cores. The location update scores one row per request, so the safety-score service now sets `n_jobs=1` after loading the model. On this machine that gave the following results (median of three 30-second runs at each concurrency level):

| Concurrency | p95 before (ms) | p95 after (ms) | p95 change | req/s before | req/s after | req/s ratio |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 74.2 | 27.1 | 63% lower | 16.3 | 41.5 | 2.5x |
| 5 | 281.4 | 144.4 | 49% lower | 22.4 | 48.8 | 2.2x |
| 10 | 549.4 | 288.6 | 47% lower | 22.3 | 48.9 | 2.2x |
| 30 | 1728.6 | 890.9 | 48% lower | 22.2 | 48.6 | 2.2x |

**Conditions.** Both sets were measured on 2026-11-28 (IST), one after the other, on the same Windows_NT 10.0.26300 x64 machine (Node v22.19.0, 16 logical cores, about 16 GB RAM), with the load generator and services sharing it. Docker Engine 28.5.1 had 16 CPUs and about 7.9 GB. Both used code at commit `d6b68a1`, differing in the safety-score model setting, with identical Python packages (Python 3.11.18, FastAPI 0.165.0, scikit-learn 1.9.1, NumPy 2.4.6) and backend Node v20.20.2. Only MongoDB, the backend and the safety-score service ran, in a separate Compose project with 20 tourist accounts and no geofences. Each matrix followed a 500-request warm-up.

**Checks.**

- No request failed (7,584 before, 16,937 after). Container logs showed one successful safety-score call per benchmark request and no backend scoring errors, so the fallback calculation was not used.
- 500 pseudo-random inputs sent to `/calculate` returned identical responses before and after, including the 4-decimal probabilities.
- `test_api_integration.py` for the safety-score service passed (6 tests) before and after the change, run outside Docker. It covers authentication and validation and does not load the model.

**Limits.** This is one local session per version, not a deployed environment, and before/after runs were not alternated. The size of the gain can differ with other hardware, library versions or batch sizes. The saved model was created with scikit-learn 1.8.0 and loaded here with 1.9.1.

| Concurrency | Run | Requests before / after | p50 ms before / after | p95 ms before / after | p99 ms before / after | req/s before / after |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1 | 490 / 1205 | 58.6 / 24.1 | 74.2 / 29.4 | 124.9 / 39.1 | 16.3 / 40.1 |
| 1 | 2 | 483 / 1246 | 57.8 / 23.8 | 88.9 / 27.1 | 124.1 / 29.8 | 16.1 / 41.5 |
| 1 | 3 | 504 / 1285 | 57.4 / 23.1 | 73.7 / 25.9 | 81.3 / 28.9 | 16.8 / 42.8 |
| 5 | 1 | 672 / 1469 | 219.0 / 106.1 | 286.1 / 144.4 | 333.2 / 161.6 | 22.3 / 48.8 |
| 5 | 2 | 677 / 1424 | 219.5 / 109.5 | 281.2 / 148.6 | 329.0 / 173.5 | 22.4 / 47.4 |
| 5 | 3 | 681 / 1468 | 216.7 / 106.4 | 281.4 / 144.2 | 313.8 / 162.6 | 22.6 / 48.9 |
| 10 | 1 | 677 / 1477 | 443.4 / 206.8 | 547.1 / 288.6 | 603.7 / 334.4 | 22.4 / 49.1 |
| 10 | 2 | 678 / 1476 | 446.6 / 203.3 | 549.4 / 280.9 | 592.1 / 321.3 | 22.3 / 48.9 |
| 10 | 3 | 666 / 1462 | 452.9 / 206.7 | 568.8 / 296.5 | 609.9 / 347.7 | 22.0 / 48.5 |
| 30 | 1 | 693 / 1508 | 1348.8 / 602.5 | 1728.6 / 890.9 | 1983.3 / 1019.3 | 22.4 / 49.7 |
| 30 | 2 | 680 / 1467 | 1398.7 / 620.3 | 1712.2 / 879.6 | 1861.8 / 1047.9 | 22.1 / 48.6 |
| 30 | 3 | 683 / 1450 | 1373.6 / 626.7 | 1788.9 / 909.6 | 1979.3 / 1084.5 | 22.2 / 47.7 |

Raw output: [before](benchmarks/results-local-compose-2026-11-28-before-njobs.json), [after](benchmarks/results-local-compose-2026-11-28-after-njobs.json).

## Scope and known limitations

- Safety-score training labels are generated from synthetic rules; model evaluation is not evidence of real-world safety prediction accuracy.
- Some dashboard analytics and alert content remain demo-oriented. Verify the source data before presenting those panels as operational analytics.
- The benchmark used one backend instance. Socket.IO broadcasts remain in-process and use one staff room; they are not shared across multiple backend instances.
- JWTs use shared-secret HS256. There is no token revocation or key rotation.
- Geofence geometry/query consistency and database query performance still need dedicated correctness and load work.
- The automated suites exercise selected auth, validation, location, scoring, persistence, socket, panic, and concurrency paths; they do not establish production reliability or broad test coverage.

## Project scripts

| Command | Action |
| --- | --- |
| `npm run dev` | Start the Vite frontend on port 3000 |
| `npm run backend` | Start the Express backend on port 5000 (requires backend dependencies) |
| `npm run ai:safety` | Start the scoring API on port 8001 |
| `npm run ai:case` | Start the report API on port 8002 |
| `npm run compose:up` | Build and start the Compose stack |
| `npm run compose:down` | Stop the Compose stack |
| `npm run bench:location` | Benchmark authenticated location updates (set `BENCH_USERNAME` and `BENCH_PASSWORD`) |
