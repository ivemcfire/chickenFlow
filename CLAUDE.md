# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**ChickenFlow** — an automated chicken coop door: Angular 21 SSR + Express backend
(single deployable), Postgres via Drizzle, an ESP32-S2 Mini as the physical
controller, and Gemini for an hourly telemetry summary. Runs on the k3s homelab
cluster (ns `chickenflow`, LB `192.168.100.211`).

**Status: pre-production.** The cluster deployment is staging; the ESP32 and
sensors are bench hardware, not yet installed in the coop. See
`chickenFlow/docs/commissioning.md` for the bench-to-coop checklist.

**This repo is PUBLIC on GitHub.** Never commit credentials, API keys, tokens,
or private coordinates. Secrets live in cluster Secrets
(`homelab-config/apps/chickenflow/secrets-stub.yaml` documents their shapes).

## Architecture in one paragraph

The ESP32 is the source of truth for physical door state and speaks **MQTT
only** (broker: ns `infra`, LB `192.168.100.207` — the firmware hardcodes that
IP). The backend mirrors device state into Postgres, runs all automation
(solar open/close, severe-weather close, manual-override expiry) as cron jobs,
and pushes live updates to the browser over WebSocket. The frontend displays
state and sends commands; it decides nothing. There is no HTTP path to the
device and no command queue — commands are published to `coop/door/cmd` and
confirmed (or not) by the device on `coop/door/status`.

## Key files

| File | Role |
|---|---|
| `chickenFlow/src/server/services/door-state.service.ts` | Single owner of door state: `getDoorState()`, `recordDeviceTransition()` (only writer of `door_events`), `requestDoorCommand()` (the one command path) |
| `chickenFlow/src/server/services/door-command-policy.ts` | Pure decision rules (settled/moving suppression, in-flight latch with expiry) — unit-tested, no I/O |
| `chickenFlow/src/server/services/mqtt-bridge.service.ts` | Broker connection (self-recreates on stuck reconnect), topic handlers, publishes. Contract: `chickenFlow/docs/mqtt-schema.md` — keep doc/firmware/backend in lock-step |
| `chickenFlow/src/server/api/schemas.ts` | Zod schemas for EVERY inbound payload (HTTP + MQTT); request types derive from these via `z.infer` |
| `chickenFlow/src/server/services/gemini.service.ts` | Gemini telemetry analysis (native fetch, `GEMINI_API_KEY`/`GEMINI_MODEL` env; degrades gracefully when unset) |
| `chickenFlow/src/server/jobs/` | node-cron: solar-automation + esp32-heartbeat (1 min), weather-poll (15 min), ai-analysis (hourly), message-cleanup (03:00). `assembleCoopTelemetry()` builds the AI's view from real tables only |
| `chickenFlow/src/server/db/schema.ts` | 9 tables; text+CHECK instead of pgEnum (deliberate — see comment there). One squashed baseline migration |
| `chickenFlow/src/app/coop-store.service.ts` | Frontend server-mirror (REST hydrate + WS updates + re-hydrate on reconnect) |
| `chickenFlow/src/app/coop-animation.service.ts` / `messages.service.ts` | Visual-only sprites / status message list |
| `chickenFlow/src/app/components/` | 8 standalone OnPush components composed by a ~20-line `app.html` |
| `chickenFlow/system-logic.md` | Implemented behavior reference — read before touching automation |

## Commands (from `chickenFlow/`)

```bash
npm run dev            # dev server :3000
npm run build          # production build (SSR + browser)
npm test               # vitest (via ng test)
npm run lint           # ESLint
npm run db:generate    # drizzle migration from schema diff
npm run db:check       # drizzle-kit check
npm run serve:ssr:app  # run built SSR + API locally
```

`.env` for local dev: copy `chickenFlow/.env.example`
(`DATABASE_URL`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `MQTT_URL`,
`FRIGATE_URL`/`FRIGATE_COOP_CAM`).

## Deployment

CI (`.github/workflows/build.yml`) runs lint+test+build as a gate, then builds
and pushes `ghcr.io/ivemcfire/chickenflow:sha-<commit>` — sha tags only, no
`latest`. **Manifests live exclusively in `homelab-config/apps/chickenflow/`**
(the `deploy/` directory here was removed); deploy = bump the image pin there
and `kubectl apply`. See `DEPLOYMENT.md`.

`/api/health` checks Postgres AND MQTT: it returns 503 after ~10 min without a
broker connection so k8s restarts a deaf pod. That is intentional.

## Rules

- Branch: `develop` (collapse to `main` pending). CI builds on push.
- The MQTT contract (`docs/mqtt-schema.md`) changes only in lock-step with
  `esp32-firmware/.../config.h` and `mqtt-bridge.service.ts`, same commit.
- Validate any new inbound payload with a zod schema in `api/schemas.ts`; no
  `req.body as X` casts.
- Never write client-supplied telemetry into server tables — assemble
  server-side (see `assembleCoopTelemetry`).
- Gates before merge: `npm run lint && npm test && npm run build` green.
