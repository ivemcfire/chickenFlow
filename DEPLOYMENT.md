# DEPLOYMENT.md — ChickenFlow Deployment

**Image registry**: `ghcr.io/ivemcfire/chickenflow` (sha-pinned tags only)
**Manifests**: `homelab-config/apps/chickenflow/` — the single source of truth.
This repo contains no deployable manifests.

## Release flow

1. Push to `develop` (or `main` post-collapse). CI
   (`.github/workflows/build.yml`) runs lint + test + build as a gate, then
   builds and pushes `ghcr.io/ivemcfire/chickenflow:sha-<7-char-commit>`.
   No `latest` tag exists — deploys are always pinned.
2. Bump the image pin in
   `homelab-config/apps/chickenflow/deploy-backend.yaml`, commit there.
3. On k3master (`.52`):
   ```bash
   kubectl apply -f ~/homelab-config/apps/chickenflow/
   kubectl -n chickenflow rollout status deploy/chickenflow-backend
   ```
   (For a quick staging roll without the manifest bump:
   `kubectl -n chickenflow set image deploy/chickenflow-backend
   chickenflow=ghcr.io/ivemcfire/chickenflow:sha-<sha>` — reconcile the
   manifest afterwards.)

## Runtime dependencies

| Thing | Where | Notes |
|---|---|---|
| Postgres | deploy `chickenflow-postgres` (ns `chickenflow`, node k3frigate) | `DATABASE_URL` from Secret; migrations run on pod start |
| MQTT broker | ns `infra`, svc `mosquitto`, LB **192.168.100.207** | IP hardcoded in ESP32 firmware — immovable. Backend uses `MQTT_URL` env (set on the Deployment) |
| Gemini | Secret `gemini-api` (`GEMINI_API_KEY`) | Missing key = AI disabled gracefully, everything else works |
| Frontend/API | svc LB **192.168.100.211** | No Ingress |
| Nightly DB backup | CronJob, pinned to k3master (phone-node DNS is broken) | dumps to jumphost `.62` |

## Health semantics

`GET /api/health` → `{status, db, mqtt:{connected,lastConnectedAt,lastError}}`.
It returns **503 once MQTT has been disconnected for ~10 min**
(`MQTT_UNHEALTHY_AFTER_MS` env). The liveness probe is expected to restart a
deaf pod — that is intentional, not a bug. The MQTT client also self-recreates
after a stuck reconnect loop to force DNS re-resolution.

## Database resets (pre-production only)

Migrations were squashed to a single baseline (2026-07-06). The staging DB was
dropped and recreated for it. If a future squash happens again pre-launch:

```bash
kubectl -n chickenflow scale deploy/chickenflow-backend --replicas=0
kubectl -n chickenflow exec deploy/chickenflow-postgres -- \
  psql -U chickenflow_user -d chickenflow \
  -c "DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;"
kubectl -n chickenflow scale deploy/chickenflow-backend --replicas=1
```

Never do this once real flock data exists.

## Verify after deploy

```bash
curl -s http://192.168.100.211/api/health          # 200, db+mqtt true
kubectl -n chickenflow logs deploy/chickenflow-backend --tail=20
#   expect: [migrate] Done, [mqtt] connected, [mqtt] retained coop/config published
curl -s -X POST http://192.168.100.211/api/door/command \
  -H 'Content-Type: application/json' -d '{"command":"OPEN","trigger":"manual"}'
#   expect: {"sent":true,...} or {"sent":false,"reason":"command-in-flight"|"already-..."}
```

Known cosmetic issue: served by raw IP, Angular SSR falls back to client-side
rendering (SSRF host guard logs `URL with hostname "192.168.100.211" is not
allowed`). Page works; fix is an SSR allowed-hosts config, tracked for later.

## Rollback

```bash
kubectl -n chickenflow set image deploy/chickenflow-backend \
  chickenflow=ghcr.io/ivemcfire/chickenflow:sha-<previous-sha>
```

Schema rollbacks are not supported — roll forward.
