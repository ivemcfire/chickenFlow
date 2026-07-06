# Bench-to-coop commissioning checklist

Everything needed to take the system from "staging with a dark device" to
live. Work top to bottom; each step has a verification.

## 1. Firmware

- [ ] Reconcile the uncommitted firmware edits on `.52:~/chickenFlow`
      (`esp32-firmware/chickenflow-esp32-s2/` — sitting in the worktree since
      ~2026-04-20) against what is actually flashed on the bench unit, then
      commit them. Do not flash blind — diff first.
- [ ] Confirm `config.h` matches `docs/mqtt-schema.md` (topics, broker IP
      `192.168.100.207`, telemetry interval 60 s).
- [ ] Flash; verify on serial that it connects to WiFi and the broker.

## 2. Real coordinates & config

- [ ] Set the real coop location (staging still carries the London defaults):
      ```sql
      UPDATE settings SET location_lat = <lat>, location_lon = <lon> WHERE id = 1;
      ```
      then restart the backend pod (republishes retained `coop/config`) or
      `PUT /api/settings` with the coords (also republishes).
- [ ] Verify the retained config:
      `mosquitto_sub -h 192.168.100.207 -t coop/config -C 1` → real lat/lon,
      correct `tz_offset_min` (Europe/Sofia: 120 winter / 180 summer).
- [ ] Set `totalChickens` to the real flock size.

## 3. Device on the bench, end to end

- [ ] `coop/telemetry` arriving every 60 s: watch
      `GET /api/esp32/status` flip to online, `device_status` row updating.
- [ ] Trip the IR tunnel beams both directions: `count_events` gains
      IN/OUT rows, `chicken_counts.netInside` moves, UI count updates live.
- [ ] Press the UI door button: device receives `coop/door/cmd`, moves, and
      `coop/door/status` lands in `door_events`; UI reflects the transition.
- [ ] 5-s physical button press: door opens, `settings.manualOverrideUntil`
      set ~15 min ahead; solar job closes it after expiry.
- [ ] Obstruction test (hand in the door path during close — carefully):
      door halts and reopens; after simulated repeated failure ends in
      `ERROR` + UI shows it; a UI command recovers.
- [ ] Pull the broker (scale mosquitto to 0 for <5 min): device enters
      MQTT-loss autonomy; backend `/api/health` still 200 (grace window);
      restore and confirm both reconnect.

## 4. Install in the coop

- [ ] Mount door hardware, tunnel, sensors; power via the intended PSU.
- [ ] Re-verify §3 items 1–3 from the coop (WiFi RSSI in telemetry should
      stay above ~-80; the AI flags weaker).
- [ ] Watch one full solar cycle (open at light-threshold after sunrise,
      close after sunset) before trusting it overnight.

## 5. Go-live checks

- [ ] `GET /api/health` green for 24 h (no restarts:
      `kubectl -n chickenflow get pods` restart counter).
- [ ] AI hourly messages describe reality (door state, counts).
- [ ] Nightly pg_dump CronJob succeeded post-commissioning
      (`kubectl -n chickenflow get jobs`).
- [ ] From this point the DB has real data: the pre-production
      drop-and-recreate procedure in DEPLOYMENT.md is retired.

## Deferred / known items

- cam12 camera fusion counting (`count_events.source='camera'`) — designed,
  not built.
- Herding / music / night-light UI switches have no hardware behind them.
- SSR-by-IP falls back to CSR (cosmetic, see DEPLOYMENT.md).
- Branch collapse `develop`→`main` + GitHub default-branch flip.
