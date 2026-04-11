# DEPLOYMENT.md — ChickenFlow First Deployment Runbook

**Audience**: Claude Opus 4.6 (k3s DevOps role)  
**Branch**: `develop`  
**Image registry**: `ghcr.io/ivemcfire/chickenflow`

---

## Production Team Context

| Role | Tool | Branch |
|------|------|--------|
| Frontend UI/UX + logic testing | AI Studio + Gemini | `main` |
| Backend + feature implementation | VS Code + Claude Sonnet | `develop` |
| **DevOps + deployment (you)** | **Claude Opus 4.6 in k3s** | **deploys from `develop`** |

**Never merge `develop` into `main` without Sonnet + AI Studio sign-off. `main` is AI Studio's working branch.**

---

## Architecture Overview

```
Internet / LAN
      │
      ▼
┌─────────────────────────────────────────────────────┐
│  k3s homelab cluster                                │
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │  chickenflow namespace                        │   │
│  │                                              │   │
│  │  Deployment (replicas: 1, strategy: Recreate)│   │
│  │  ┌────────────────────────────────────────┐  │   │
│  │  │ chickenflow pod (port 4000)            │  │   │
│  │  │  - Angular SSR (Express)               │  │   │
│  │  │  - REST API  /api/*                    │  │   │
│  │  │  - WebSocket /ws                       │  │   │
│  │  │  - node-cron jobs                      │  │   │
│  │  │  - SQLite on /data (PVC)               │  │   │
│  │  └────────────────────────────────────────┘  │   │
│  │           │                                  │   │
│  │    PVC (local-path, 2Gi) → /data/            │   │
│  │      chickenflow.db                          │   │
│  │      captures/*.jpg                          │   │
│  └──────────────────────────────────────────────┘   │
│                                                     │
│  Service: LoadBalancer (MetalLB) or NodePort        │
│    → ESP32-CAM connects here via plain HTTP         │
│    → Browser connects here for the Angular UI       │
└─────────────────────────────────────────────────────┘

ESP32-CAM (edge device, LAN only)
  POST /api/esp32/sensor    — sensor readings
  POST /api/esp32/capture   — JPEG image (max 4MB)
  POST /api/esp32/door-event — state changes
  GET  /api/esp32/command   — poll for door commands (every 5s)
```

---

## Prerequisites Checklist

Before running any deployment steps, verify:

- [ ] `kubectl` configured with cluster access (`kubectl cluster-info`)
- [ ] k3s `local-path` provisioner is active (`kubectl get sc`)
- [ ] MetalLB installed OR you will use NodePort — decide now
- [ ] Docker or Buildah available for image build
- [ ] `gh` CLI authenticated (`gh auth status`)
- [ ] You have the `ANTHROPIC_API_KEY` value for the secret
- [ ] You know which node will hold the PVC (`kubectl get nodes`)
- [ ] Port 4000 (or NodePort 30400) is reachable from the ESP32-CAM subnet

---

## Step 1 — Build & Push the Image

CI builds automatically on every push to `develop` via GitHub Actions (`.github/workflows/build.yml`). The image lands at `ghcr.io/ivemcfire/chickenflow:latest`.

**To trigger CI manually:**
```bash
gh workflow run build.yml --repo ivemcfire/chickenFlow --ref develop
gh run watch  # tail the run
```

**To build locally and push (fallback if CI is unavailable):**
```bash
make build
docker login ghcr.io -u ivemcfire --password-stdin <<< $(gh auth token)
make push
```

**To import a locally built image directly into k3s (air-gap / no registry):**
```bash
docker save ghcr.io/ivemcfire/chickenflow:latest | sudo k3s ctr images import -
```

---

## Step 2 — First-Time Cluster Setup

Run these **once**. They are idempotent — safe to re-run.

### 2a. Label the storage node

The PVC uses `local-path` provisioner, which binds to a specific node. Pin the pod to that node:

```bash
# List nodes — pick the one with the most free disk
kubectl get nodes -o wide

# Label it (replace <node-name>)
make node-label NODE=<node-name>
# or directly:
kubectl label node <node-name> chickenflow/storage=true --overwrite

# Verify
kubectl get nodes --show-labels | grep chickenflow
```

### 2b. Create the namespace

```bash
kubectl apply -f chickenFlow/deploy/namespace.yaml
# Expected: namespace/chickenflow created (or configured)
```

### 2c. Create the API key secret

**Do NOT use the `deploy/secret.yaml` file** — it contains only a placeholder. Create the secret imperatively so the real key is never in git:

```bash
make secret-create KEY=sk-ant-YOUR_REAL_KEY_HERE
# or directly:
kubectl create secret generic ai-secret \
  --from-literal=api-key="sk-ant-YOUR_REAL_KEY_HERE" \
  --namespace=chickenflow \
  --dry-run=client -o yaml | kubectl apply -f -

# Verify (shows only the key name, not value)
kubectl get secret ai-secret -n chickenflow
```

### 2d. Enable ghcr.io image pull (if repo is private)

```bash
kubectl create secret docker-registry ghcr-secret \
  --docker-server=ghcr.io \
  --docker-username=ivemcfire \
  --docker-password=$(gh auth token) \
  --namespace=chickenflow \
  --dry-run=client -o yaml | kubectl apply -f -

# Then add to the deployment spec under spec.template.spec:
#   imagePullSecrets:
#     - name: ghcr-secret
# Or make the ghcr.io package public in GitHub → Packages settings.
```

---

## Step 3 — Deploy

```bash
make deploy
```

This applies in order:
1. `namespace.yaml`
2. `configmap.yaml` — PORT, DB_PATH, CAPTURES_DIR
3. `pvc.yaml` — 2Gi local-path PVC
4. `deployment.yaml` — single-replica pod with readiness/liveness probes
5. `service.yaml` — LoadBalancer (MetalLB) or NodePort

**Watch the rollout:**
```bash
kubectl rollout status deployment/chickenflow-backend -n chickenflow
# Expected: deployment "chickenflow-backend" successfully rolled out
```

**The pod's CMD runs `drizzle-kit migrate` before starting Node.** On first deploy, this creates all 7 tables in `/data/chickenflow.db`. On subsequent deploys, it's a no-op if schema is unchanged.

---

## Step 4 — Verify the Deployment

```bash
make verify-first-deploy
```

This runs 5 checks inside the pod:

1. **Health probe** — `GET /api/health` → `{"status":"ok","dbWritable":true}`
2. **Settings endpoint** — `GET /api/settings` → default settings JSON
3. **Weather cache** — `GET /api/weather/today` → populated by startup job (Open-Meteo fetch runs immediately on first start)
4. **AI log** — `GET /api/ai/log` → empty array is correct on first deploy
5. **Pod logs** — watch for scheduler registration and WebSocket attach messages

**Expected log output on healthy first boot:**
```
[WS] WebSocket server attached on /ws
[Scheduler] Jobs registered: weather-poll (*/15m), ai-analysis (hourly @:03), message-cleanup (03:00)
[Job:weather-poll] Running
[Weather] Cached 5 forecast days. Today: code=1, severe=false
ChickenFlow SSR + API listening on http://localhost:4000
WebSocket endpoint: ws://localhost:4000/ws
```

---

## Step 5 — Network Verification

### Get the service IP

**MetalLB:**
```bash
kubectl get svc chickenflow-svc -n chickenflow
# EXTERNAL-IP should show your MetalLB IP (e.g. 192.168.1.50)
```

**NodePort fallback:**
```bash
# If MetalLB is unavailable, patch the service:
kubectl patch svc chickenflow-svc -n chickenflow \
  -p '{"spec":{"type":"NodePort","ports":[{"port":80,"targetPort":4000,"nodePort":30400}]}}'
# Use any node's LAN IP + port 30400
```

### Test from a browser
```
http://<service-ip>/           → Angular app loads
http://<service-ip>/api/health → {"status":"ok","dbWritable":true}
ws://<service-ip>:4000/ws      → WebSocket connects (use browser console)
```

### Simulate an ESP32-CAM sensor reading
```bash
curl -X POST http://<service-ip>/api/esp32/sensor \
  -H 'Content-Type: application/json' \
  -d '{"distanceCm":45,"irTriggered":false,"chickensInside":8,"totalChickens":10,"doorState":"CLOSED"}'
# Expected: {"ok":true}  HTTP 201
```

### Simulate a door command (verify ESP32 poll loop)
```bash
# Queue a command
curl -X POST http://<service-ip>/api/door/command \
  -H 'Content-Type: application/json' \
  -d '{"command":"OPEN","trigger":"manual"}'

# Poll it (simulates ESP32 GET)
curl http://<service-ip>/api/esp32/command
# Expected: {"action":"OPEN","delay":0}

# Poll again (should reset to NONE)
curl http://<service-ip>/api/esp32/command
# Expected: {"action":"NONE","delay":0}
```

---

## Ongoing Operations

### View logs
```bash
make logs
```

### Force pod restart (e.g. after secret rotation)
```bash
make restart
```

### Roll back to previous image
```bash
make rollback
```

### Open SQLite shell on the pod
```bash
make db-shell
# Then: .tables  |  SELECT * FROM settings;  |  .quit
```

### Deploy a new image after Sonnet pushes to develop
```bash
# CI builds automatically — just wait for the GitHub Action to finish, then:
kubectl set image deployment/chickenflow-backend \
  chickenflow=ghcr.io/ivemcfire/chickenflow:sha-<new-sha> \
  -n chickenflow
kubectl rollout status deployment/chickenflow-backend -n chickenflow
```

---

## Known Constraints

| Constraint | Reason | Action |
|-----------|--------|--------|
| `replicas: 1` only | SQLite is single-writer | Never scale up |
| `strategy: Recreate` | Two pods on same `.db` = corruption | Never change to RollingUpdate |
| `local-path` PVC only | SQLite locks fail on NFS | Do not migrate to Longhorn/NFS |
| ESP32 on plain HTTP | ESP32-CAM can't handle TLS 1.3 | Keep port 80/30400 unencrypted on LAN |
| Image body size 4MB | ESP32-CAM JPEG frames | Ingress `proxy-body-size: 4m` is set |

---

## Failure Scenarios & Recovery

### Pod is in `CrashLoopBackOff`
```bash
kubectl describe pod -n chickenflow -l app=chickenflow
kubectl logs -n chickenflow -l app=chickenflow --previous
```
Common causes:
- Missing `ai-secret` → create it with `make secret-create KEY=...`
- DB path not writable → check PVC is bound (`kubectl get pvc -n chickenflow`)
- Image pull error → verify ghcr.io access or run `make push`

### Pod passes liveness but `/api/health` returns 503
The PVC has gone read-only (rare with local-path, common if disk is full). Check:
```bash
kubectl exec -n chickenflow -l app=chickenflow -- df -h /data
```

### ESP32 getting `413 Request Entity Too Large`
The Ingress `proxy-body-size` annotation may not be applied. Verify:
```bash
kubectl describe ingress chickenflow-ingress -n chickenflow | grep proxy-body-size
```
If missing, re-apply: `kubectl apply -f chickenFlow/deploy/ingress.yaml`

### Weather job fails (Open-Meteo unreachable)
The startup weather fetch failure is non-fatal — the scheduler retries at the next 15-minute mark. Check:
```bash
make logs | grep "weather-poll"
```

---

## Handover Checklist (First Deploy Complete When)

- [ ] `kubectl get pods -n chickenflow` shows `Running` and `1/1 READY`
- [ ] `make health` returns `{"status":"ok","dbWritable":true}`
- [ ] `make verify-first-deploy` passes all 5 checks
- [ ] Service has an external IP (MetalLB) or NodePort is accessible
- [ ] ESP32-CAM sensor POST returns HTTP 201
- [ ] ESP32-CAM command poll GET returns `{"action":"NONE","delay":0}`
- [ ] Angular UI loads at the service IP
- [ ] Weather cache is populated (`GET /api/weather/today` returns data)
- [ ] Pod logs show scheduler running and no error stack traces
