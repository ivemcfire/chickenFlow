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
- **Google Gemini** (AI Studio frontend, client-side) — UI/UX design and logic simulation
- **Claude claude-sonnet-4-6** (backend, server-side) — production AI analysis with full audit trail
- **Open-Meteo** — weather and solar data
- **ESP32-CAM** — edge device (image capture, ultrasonic sensor, IR, door motor control)
- **k3s homelab cluster** — production deployment target

---

## Commands

All commands run from the `chickenFlow/` directory.

### Development (Sonnet's lane)
```bash
npm run dev             # Angular dev server on port 3000 (GEMINI_API_KEY required)
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

**Environment variable for local dev**: Copy `chickenFlow/.env.example` to `chickenFlow/.env` and set `ANTHROPIC_API_KEY`.

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
│   │       ├── services/        ← Claude AI + weather services
│   │       └── ws/              ← WebSocket server + broadcaster
│   ├── deploy/                  ← k3s manifests (Opus's territory)
│   └── Dockerfile               ← Multi-stage build, runs migrations on start
├── CLAUDE.md                    ← This file
└── DEPLOYMENT.md                ← Opus handover doc (first deployment runbook)
```

### Key Files

- `src/app/coop-state.service.ts` — All frontend state + automation logic (~750 lines, Angular Signals)
- `src/server.ts` — Express entry point: mounts `/api`, WebSocket, scheduler
- `src/server/db/schema.ts` — 7 Drizzle tables (settings, door_events, sensor_readings, status_messages, weather_cache, ai_analysis_log, camera_captures)
- `src/server/services/claude.service.ts` — Telemetry + multimodal vision analysis
- `src/server/api/sensor.routes.ts` — ESP32-CAM ingest (multer + sharp)
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

**Backend** (SQLite via Drizzle):

| Table | Purpose | Retention |
|-------|---------|-----------|
| `settings` | Single-row config + ESP32 `pendingCommand` | Permanent |
| `door_events` | Immutable state transition log | Permanent |
| `sensor_readings` | ESP32 ultrasonic + IR time-series | 7 days |
| `status_messages` | Replaces localStorage | 30 days (non-pinned) |
| `weather_cache` | Open-Meteo forecast cache | Rolling |
| `ai_analysis_log` | Every Claude call audit trail | Permanent |
| `camera_captures` | ESP32-CAM image metadata | 48h / 30d (anomaly) |

### ESP32-CAM Integration

The ESP32-CAM communicates with the backend via plain HTTP (no TLS, no WebSocket — too heavy for the microcontroller):

```
POST /api/esp32/sensor     ← sensor readings (JSON)
POST /api/esp32/capture    ← image upload (multipart/form-data, max 4MB)
POST /api/esp32/door-event ← state changes
GET  /api/esp32/command    ← poll for door commands (reads + resets pendingCommand atomically)
```

### Background Jobs

| Job | Schedule | Purpose |
|-----|----------|---------|
| `weather-poll` | `*/15 * * * *` | Fetch Open-Meteo, update cache, queue CLOSE if severe |
| `ai-analysis` | `3 * * * *` | Hourly Claude telemetry analysis |
| `message-cleanup` | `0 3 * * *` | Prune old messages, sensor rows, and image files |

### AI Integration (Backend)

`claude.service.ts` has two modes:
1. **Telemetry-only** — structured JSON prompt → 15-25 word status text
2. **Vision** — base64 image + telemetry JSON → `{"anomaly": bool, "count_confirmed": bool, "message": "...", "threat_type": null | "predator" | "obstruction" | "injury"}`

Predator detection auto-queues a `CLOSE` command to `settings.pendingCommand` and pins a `VISION_THREAT` alert.

### Migration Path (localStorage → DB)

- **Phase 1** (current): Dual-write — frontend still uses localStorage, backend API is additive
- **Phase 2**: Messages move to DB; `POST /api/migrate/localstorage` seeds existing data
- **Phase 3**: Full server authority — remove `@google/genai` from client bundle

---

## Tech Stack

- **Angular 21** with Signals (strict mode, OnPush)
- **Angular Material** + **Tailwind CSS v4**
- **Express v5** + **Angular SSR**
- **Drizzle ORM** + **better-sqlite3** (WAL mode)
- **ws** WebSocket (native, no Socket.io)
- **node-cron** background jobs
- **multer** + **sharp** for ESP32-CAM image ingest
- **Anthropic SDK** (`claude-sonnet-4-6`)
- **TypeScript 5.9** — strict mode, ES2022
- **Vitest** + jsdom for testing
- **Docker** (multi-stage) + **k3s** (homelab)
