# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Production Team Workflow

Three roles, three tools — each has a defined lane:

| Role | Tool | Responsibility |
|------|------|----------------|
| **Frontend UI/UX + logic testing** | AI Studio + Gemini | Angular templates, component design, `coop-state.service.ts` logic, UX flows. Works on `main` branch. |
| **Backend + feature implementation** | VS Code + Claude Sonnet | API routes, DB schema, services, jobs, WebSocket. Works on `develop` branch. |
| **DevOps + deployment** | Claude Opus 4.6 in k3s | Docker builds, k3s manifests, CI/CD, health verification, rollbacks. Works from `develop`, deploys to cluster. |

**Branch rules**: `main` is AI Studio territory — never push backend code there. All backend work goes to `develop`. Opus deploys from `develop`.

---

## Project Overview

**ChickenFlow** is an Angular 21 web application for an AI-powered automated chicken coop door. It integrates:
- **Ollama** (`qwen2.5:3b-instruct-q4_K_M` on `one6t`, reached via in-cluster DNS) — backend hourly telemetry analysis, fully local, no cloud API
- **Open-Meteo** — weather and solar data
- **ESP32-S2 Mini** — edge device (limit switch + IR, door motor control, HTTP polling). Legacy ESP32-CAM hardware has been replaced.
- **Frigate + cam01 (NETSurveillance)** — video feed and snapshot source, proxied via `/api/camera/snapshot` (observational only)
- **k3s homelab cluster** — production deployment target

---

## Commands

All commands run from the `chickenFlow/` directory.

### Development (Sonnet's lane)
```bash
npm run dev             # Angular dev server on port 3000
npm run build           # Production build
npm run test            # Vitest unit tests
npm run lint            # ESLint
npm run serve:ssr:app   # Run SSR + API server locally
```

### Database
```bash
npm run db:generate     # Generate migration SQL from schema changes
npm run db:migrate      # Apply pending migrations
npm run db:studio       # Open Drizzle Studio (visual DB browser)
```

### Deployment (Opus's lane — run from repo root)
```bash
make build              # Docker build + tag
make push               # Push to ghcr.io
make deploy             # kubectl apply all manifests
make status             # Pod/service status
make health             # curl /api/health
make logs               # Follow pod logs
make rollback           # Roll back to previous image
```

**Environment variables for local dev**: Copy `chickenFlow/.env.example` to `chickenFlow/.env` and set:
- `OLLAMA_URL` — Ollama base URL (default: `http://ollama.chickenflow.svc.cluster.local:11434`)
- `OLLAMA_MODEL` — model tag (default: `qwen2.5:3b-instruct-q4_K_M`)
- `DATABASE_URL` — Postgres connection string (e.g. `postgres://user:pass@host:5432/chickenflow`)
- `FRIGATE_URL` + `FRIGATE_COOP_CAM` — Frigate base URL and camera name for the snapshot proxy

---

## Architecture

### Repository Structure

```
chicken-flow-app/
├── chickenFlow/                 ← Angular app + backend (single deployable unit)
│   ├── src/
│   │   ├── app/                 ← Angular frontend (AI Studio's territory)
│   │   │   ├── app.ts           ← Root component (OnPush)
│   │   │   ├── app.html         ← Entire UI template
│   │   │   └── coop-state.service.ts  ← All frontend state + automation logic
│   │   └── server/              ← Backend (Sonnet's territory)
│   │       ├── api/             ← REST route handlers
│   │       ├── db/              ← Drizzle schema + migrations
│   │       ├── jobs/            ← node-cron background jobs
│   │       ├── middleware/      ← Express middleware
│   │       ├── services/        ← Ollama AI + weather + Frigate services
│   │       └── ws/              ← WebSocket server + broadcaster
│   ├── deploy/                  ← k3s manifests (Opus's territory)
│   └── Dockerfile               ← Multi-stage build, runs migrations on start
├── CLAUDE.md                    ← This file
└── DEPLOYMENT.md                ← Opus handover doc (first deployment runbook)
```

### Key Files

- `src/app/coop-state.service.ts` — All frontend state + automation logic (~750 lines, Angular Signals)
- `src/server.ts` — Express entry point: mounts `/api`, WebSocket, scheduler
- `src/server/db/schema.ts` — 7 Drizzle **Postgres** tables (settings, door_events, sensor_readings, status_messages, weather_cache, ai_analysis_log, camera_captures)
- `src/server/services/ollama.service.ts` — Ollama telemetry analysis (hourly, burst cron only; no vision)
- `src/server/services/frigate.service.ts` — Frigate snapshot proxy helper (observational only)
- `src/server/api/sensor.routes.ts` — ESP32-S2 Mini sensor/door-event/command ingest
- `src/server/api/camera.routes.ts` — Frigate snapshot proxy (`/api/camera/snapshot`)
- `system-logic.md` — Domain logic documentation (read before editing automation)

### State Management

**Frontend** (Angular Signals in `CoopStateService`):

| Signal | Purpose |
|--------|---------|
| `doorState` | OPEN/CLOSED/OPENING/CLOSING/ERROR |
| `chickens[]` | x,y positions + isInside per chicken |
| `weatherLock` | Severe weather lockdown |
| `serviceMode` | Disables all automation |
| `statusMessages[]` | System event log |

**Backend** (Postgres via Drizzle `pg-core`):

| Table | Purpose | Retention |
|-------|---------|-----------|
| `settings` | Single-row config + ESP32 `pendingCommand` | Permanent |
| `door_events` | Immutable state transition log | Permanent |
| `sensor_readings` | ESP32-S2 limit-switch + IR time-series | 7 days |
| `status_messages` | Replaces localStorage | 30 days (non-pinned) |
| `weather_cache` | Open-Meteo forecast cache | Rolling |
| `ai_analysis_log` | Every Ollama telemetry call audit trail | Permanent |
| `camera_captures` | Frigate snapshot metadata | 48h |

### ESP32-S2 Mini Integration

The ESP32-S2 Mini communicates with the backend via plain HTTP (no TLS, no WebSocket — too heavy for the microcontroller). Image capture now comes from Frigate/cam01, not the microcontroller.

```
POST /api/esp32/sensor     ← sensor readings (JSON; limit switch + IR)
POST /api/esp32/door-event ← state changes
GET  /api/esp32/command    ← poll for door commands (reads + resets pendingCommand atomically)
```

### Background Jobs

| Job | Schedule | Purpose |
|-----|----------|---------|
| `weather-poll` | `*/15 * * * *` | Fetch Open-Meteo, update cache, queue CLOSE if severe |
| `ai-analysis` | `3 * * * *` | Hourly Ollama telemetry analysis (burst cron; no continuous inference) |
| `message-cleanup` | `0 3 * * *` | Prune old messages, sensor rows, and image files |

### AI Integration (Backend)

`ollama.service.ts` calls **Ollama** via native `fetch` against the Ollama REST API (`/api/generate`). The backend reaches Ollama at the in-cluster Kubernetes Service DNS name:

```
http://ollama.chickenflow.svc.cluster.local:11434
```

Configured via `OLLAMA_URL` (default above) and `OLLAMA_MODEL` (default `qwen2.5:3b-instruct-q4_K_M`). No credentials required — in-cluster trusted network.

**Mode: Telemetry-only** — structured JSON telemetry prompt → 15-25 word status text. Runs as a burst cron job (hourly at `:03`); no continuous or per-request inference (thermal constraint on SD845 passive cooling on node `one6t`).

**Vision analysis: removed.** `analyzeCapture()` and `/api/ai/capture` no longer exist. The camera (Frigate/cam01) is observational only, proxied via `/api/camera/snapshot`.

**Obstruction AI: removed.** The `/api/esp32/obstruction-check` endpoint degrades to a safe pass-through (`{ abort: false, confidence: 0, reason: 'hardware-authoritative' }`). Dual-IR tunnel sensors and motor stall detection on the ESP32-S2 are authoritative for obstruction safety.

See `docs/migration-ollama.md` for the full migration decision record.

### Migration Path (localStorage → DB)

- **Phase 1** (complete): Dual-write — frontend used localStorage, backend API was additive
- **Phase 2** (complete): Messages moved to DB; `POST /api/migrate/localstorage` seeds existing data
- **Phase 3** (complete): Full server authority — `@google/genai` removed from the bundle; AI backend is now local Ollama

---

## Tech Stack

- **Angular 21** with Signals (strict mode, OnPush)
- **Angular Material** + **Tailwind CSS v4**
- **Express v5** + **Angular SSR**
- **Drizzle ORM** + **Postgres** (`postgres-js` driver, `pg-core` schema)
- **ws** WebSocket (native, no Socket.io)
- **node-cron** background jobs
- **multer** + **sharp** for image ingest (legacy upload path; live view now proxies Frigate)
- **Ollama** — local inference via native `fetch` to `/api/generate` (no SDK dependency)
- **TypeScript 5.9** — strict mode, ES2022
- **Vitest** + jsdom for testing
- **Docker** (multi-stage) + **k3s** (homelab)
