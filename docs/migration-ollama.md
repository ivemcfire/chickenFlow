# Architecture Decision Record: Gemini → Ollama Migration

**Date:** 2026-04-17  
**Status:** Locked — ships as a single end-to-end PR

---

## Why

Eliminate the cloud API dependency and run AI fully offline. Google Gemini (`gemini-2.5-flash-lite`) was the only remaining cloud service. After the i5-6600 + GTX 1050 Ti PC joined the homelab as a second k3s control plane and took over Frigate face recognition, three SD845 phones were freed up. One of those phones (`one6t`) now runs Ollama in-cluster, making a fully local AI stack viable.

**Node roles (decided 2026-04-17):**
- `one6t` (8 GB RAM) — Ollama inference
- `one61` (6 GB RAM) — Home Assistant
- `one62` (6 GB RAM) — spare

**Thermal constraint:** SD845 passive cooling cannot sustain continuous inference. AI runs are burst cron jobs only. The current hourly cadence is acceptable; continuous or per-request inference is not.

---

## Locked Decisions

### 1. AI Obstruction Check Dropped Entirely

Hardware is authoritative for obstruction safety. The dual-IR tunnel sensors plus motor stall detection on the ESP32-S2 Mini handle this at the edge. No LLM is involved.

`assessObstruction()` and its call site in `src/server/api/sensor.routes.ts` will be removed.

### 2. Vision Analysis Dropped Entirely

`analyzeCapture()` and the `/api/ai/capture` endpoint will be removed. The camera (Frigate/cam01 at `192.168.100.11`, proxied via `/api/camera/snapshot`) is **observational only** — no object detection, no anomaly classification, no vision-language model of any kind. Frigate's own pipeline (running on the PC with the 1050 Ti) handles any computer vision needs at the NVR level.

### 3. Ollama Transport: Cluster Service

The backend reaches Ollama via the in-cluster Kubernetes Service DNS name:

```
http://ollama.chickenflow.svc.cluster.local:11434
```

Configured via the `OLLAMA_URL` environment variable (default is the address above). No credentials required — in-cluster, trusted network.

### 4. Model: `qwen2.5:3b-instruct-q4_K_M`

Running on node `one6t` (8 GB SD845). Chosen for reliable structured-JSON output at approximately 2 GB RAM footprint, leaving headroom on the 8 GB device. Configured via the `OLLAMA_MODEL` environment variable.

### 5. Rename `claude.service.ts` → `ollama.service.ts`

The historical filename is misleading — the file never called Claude; it has always called whatever the current AI backend was (first Claude, then Gemini). This migration is the right moment to clean it up. The rename happens in the same PR.

### 6. Purge `@google/genai` and `@anthropic-ai/sdk`

Both SDKs are removed in the same PR:

- `@google/genai` — replaced by the Ollama HTTP client
- `@anthropic-ai/sdk` — dead weight; listed in `package.json` and referenced by a stray `ANTHROPIC_API_KEY` in `.env.example`, but never imported anywhere in the codebase

The `ANTHROPIC_API_KEY` entry in `.env.example` is also removed.

### 7. Thermal Monitoring: Out of Scope for This App

Grafana handles SD845 thermal telemetry from `one6t` at the infrastructure level. No app-side thermal endpoints or monitoring will be added to ChickenFlow.

### 8. Single End-to-End PR, No Feature Flag

The migration ships atomically: one PR from `develop`, deployed by Opus to the cluster from `production`. No staged rollout, no feature flag, no parallel Gemini fallback. The old cloud path is deleted, not gated.
