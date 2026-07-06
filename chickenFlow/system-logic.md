# ChickenFlow System Logic

Implemented behavior of the coop door system as of the 2026-07 refactor.
The server is authoritative for all decisions; the device is authoritative
for physical state; the frontend only displays and requests.

## 1. Door state

- Source of truth: the ESP32, which publishes every transition on
  `coop/door/status` (retained). The backend records transitions in
  `door_events` via `recordDeviceTransition()` — the ONLY writer. Duplicate
  retained-status replays are deduped by comparing against the latest state.
- `GET /api/door/state` returns the latest `door_events.toState`, or
  `UNKNOWN` when the log is empty (fresh install / device never seen).
- States: `OPEN | CLOSED | OPENING | CLOSING | ERROR` (+ `UNKNOWN` read-side).

## 2. Command path

All door commands — UI button, solar automation, weather lockdown — go through
`requestDoorCommand(action, trigger)`:

1. Policy check (`door-command-policy.ts`, pure + unit-tested): skip if the
   door is already in the settled target state, already moving toward it, or a
   previous command is **in flight** (published but not yet confirmed).
2. The in-flight latch expires after **60 s** (device travel watchdog is 15 s
   + margin), so a command the device never confirms can never block
   automation permanently.
3. Publish `coop/door/cmd` (QoS 1). If the broker is unreachable the caller
   gets `{sent:false, reason:'mqtt-disconnected'}` — the UI surfaces this;
   `POST /api/door/command` returns 503.
4. No door_events row is written on command — only on device confirmation.
   A dark device means honest silence, not fake OPENING rows.

## 3. Automation (backend cron)

### Solar (`solar-automation.job`, every minute)
- Skipped when `serviceMode` is on or `automaticDoor` is off.
- Day (between today's sunrise/sunset from `weather_cache`): if the door isn't
  OPEN/OPENING, open when the device light level ≥ `lightThreshold`
  (default 2000), OR unconditionally 90 min past sunrise (LDR-failsafe, with a
  pinned warning to inspect the sensor). Severe-weather days are left to the
  weather job.
- Night: close if not already CLOSED/CLOSING.
- Manual-override window: while `settings.manualOverrideUntil` is in the
  future, the job does nothing; on expiry it clears the field and commands
  CLOSE (automation resumes).

### Weather (`weather-poll.job`, every 15 min)
- Fetches Open-Meteo into `weather_cache` (one row per date, `isSevere` from
  weather codes).
- If today is severe: command CLOSE (idempotent — the policy layer suppresses
  repeats). Respects `serviceMode` and an active manual override.

### Manual override (15 min)
- Physical 5-s button press arrives as `coop/door/status` with
  `last_event:"manual"`: OPEN sets `manualOverrideUntil = now+15min`,
  CLOSE clears it.
- UI commands with trigger `manual` mirror the same semantics.

### Heartbeat (`esp32-heartbeat.job`, every minute)
- `device_status.lastSeen` updated on any MQTT traffic from the device;
  offline after 15 min of silence → pinned alert + WS `esp32:status`.

## 4. Counting

- Dual-IR tunnel beams on the device emit one `coop/count` message per transit
  (`dir: IN|OUT`, QoS 1).
- Backend appends a raw `count_events` row (`source:'beam'`; `'camera'` is
  reserved for the planned cam12 fusion) AND atomically upserts the daily
  tally in `chicken_counts` (keyed on Europe/Sofia local date).
- `netInside` drives the UI count and the sprite animation. Raw events are
  never discarded.

## 5. AI (Gemini)

- Hourly job + on-demand `POST /api/ai/analyze` share
  `assembleCoopTelemetry()`: door state, today's counts, device diagnostics
  (`device_status`), weather, settings — **server state only**; the client can
  contribute a `contextNote` string, nothing else.
- `gemini.service.ts` calls the Gemini API with native fetch
  (`GEMINI_API_KEY` + `GEMINI_MODEL`, default `gemini-2.5-flash`,
  thinking disabled, 30 s timeout). Missing key = one startup warning,
  failures recorded in `ai_analysis_log`, never a crash.
- Output: 15–25 word status text, `WARNING:` prefix rules for drift /
  low-voltage / weak-RSSI / hot device. Result lands in `status_messages` and
  broadcasts over WS.

## 6. Safety (hardware-authoritative)

Obstruction handling lives entirely on the ESP32: dual-IR + INA219 motor-stall
detection halt and reopen the door; after 3 failed close attempts it holds
OPEN in `ERROR` with local alerts. The backend performs no obstruction logic;
commanding a move is the recovery path out of `ERROR`. The device also has a
5-min MQTT-loss autonomy fallback.

## 7. Messages & alerts

- `status_messages`: server-generated serial ids, `createdAt` timestamps;
  non-pinned rows pruned at 30 days (cleanup job at 03:00).
- WS `system:alert` broadcasts are ephemeral (not persisted); the frontend
  lists them with synthetic negative ids alongside persisted rows.

## 8. UI-only features (no backend/hardware yet)

Herding mode, music signal, and smart night light exist as visual switches in
the frontend only — no backend endpoints, no firmware support. The old
"herding loop / 80% flock / abandonment heartbeat" logic described in earlier
versions of this document was frontend fiction and was removed in WP4.
