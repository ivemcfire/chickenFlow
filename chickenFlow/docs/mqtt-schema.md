# ChickenFlow MQTT Schema

The single source of truth for the firmware ↔ backend contract. Any change
here must land in both `esp32-firmware/chickenflow-esp32-s2/src/config.h` and
`chickenFlow/src/server/services/mqtt-bridge.service.ts` in the same commit.

**Broker**: `mosquitto` in the `infra` namespace on k3s (moved from `hydroflow` 2026-07-06).
- Cluster-internal (backend): `mqtt://mosquitto.infra.svc.cluster.local:1883`
- LAN (ESP32): `mqtt://192.168.100.207:1883`

**Conventions**
- All timestamps are ISO 8601 UTC strings (`2026-04-14T10:00:00Z`).
- The `chicken_counts.date` column is **local** (`Europe/Sofia`) `YYYY-MM-DD`, not UTC.
- All topic names are lowercase, slash-separated, no trailing slash.
- Unknown fields MUST be ignored by both sides (forward compatibility).

---

## Topics

### `coop/telemetry`   ESP → K3s · QoS 0 · retain=no

Periodic health ping. Emitted every `MQTT_TELEMETRY_INTERVAL_MS` (60 s by default).

```json
{
  "temp":       22.1,    // °C, from DS3231 ambient or motor housing probe
  "ma":         148,     // INA219 rolling average, milliamps
  "v":          12.1,    // INA219 bus voltage
  "rssi":       -58,     // WiFi signal strength
  "uptime_s":   1840,
  "lightLevel": 2400     // LDR raw ADC (0-4095), EMA-smoothed on-device
}
```

Backend action: upsert `device_status` row (last_seen + diagnostic fields), broadcast `sensor:reading` over WebSocket.

---

### `coop/count`   ESP → K3s · QoS 1 · retain=no

One message per directional transit event (A→B or B→A sequence completed).

```json
{
  "dir": "IN",                        // "IN" | "OUT"
  "ts":  "2026-04-14T10:00:00Z"
}
```

- `IN`  = yard → coop  (beam A then beam B)
- `OUT` = coop → yard  (beam B then beam A)

Backend action: append a raw `count_events` row (`source: 'beam'`), then atomic UPSERT into `chicken_counts` keyed on local date.
- `IN`  → `(total_in +1, total_out +0, net_inside +1)`
- `OUT` → `(total_in +0, total_out +1, net_inside -1)`

QoS 1 is mandatory: a lost transit event permanently corrupts the daily tally.

---

### `coop/door/status`   ESP → K3s · QoS 1 · retain=yes

Published on every door state transition. Retained so a freshly subscribed
backend sees the current physical state immediately.

```json
{
  "state":      "OPEN",              // "OPEN" | "CLOSED" | "OPENING" | "CLOSING" | "ERROR"
  "last_event": "solar",             // "solar" | "manual" | "mqtt" | "obstruction" | "boot"
  "from_state": "CLOSED",
  "limit_top":  true,
  "limit_bot":  false,
  "ma_peak":    420                  // INA219 peak observed during the move
}
```

Backend action: append `door_events`, broadcast `door:state_changed`.

---

### `coop/door/cmd`   K3s → ESP · QoS 1 · retain=no

Command from UI / automation. The ESP32 is the source of truth for physical
state; the backend only *requests*.

```json
{
  "action":  "OPEN",                 // "OPEN" | "CLOSE"
  "force":   false,                  // true bypasses service mode + weather lock
  "trigger": "solar-auto",           // free-form label for audit trail
  "req_id":  "1713088800123"
}
```

QoS 1 so a dropped connection doesn't silently swallow a close command at dusk.

---

### `coop/config`   K3s → ESP · QoS 1 · retain=yes

OTA configuration. Retained so a rebooting ESP32 receives it as its first
message on (re)subscribe.

```json
{
  "lat":                 43.5167,
  "lon":                 26.8333,
  "tz_offset_min":       120,        // minutes east of UTC
  "solar_nudge_min":     0,          // offset applied to both sunrise and sunset
  "travel_ms_watchdog":  15000
}
```

Published by the backend on:
1. MQTT bridge startup
2. Any update to `settings.locationLat` / `settings.locationLon`

---

## Testing with mosquitto_pub / _sub

From any LAN host:

```bash
# Fake a telemetry ping
mosquitto_pub -h 192.168.100.207 -t coop/telemetry \
  -m '{"temp":22,"ma":140,"v":12.1,"rssi":-58,"uptime_s":900}'

# Fake two chickens in, one out
mosquitto_pub -h 192.168.100.207 -t coop/count -q 1 \
  -m '{"dir":"IN","ts":"2026-04-14T10:00:00Z"}'
mosquitto_pub -h 192.168.100.207 -t coop/count -q 1 \
  -m '{"dir":"IN","ts":"2026-04-14T10:00:01Z"}'
mosquitto_pub -h 192.168.100.207 -t coop/count -q 1 \
  -m '{"dir":"OUT","ts":"2026-04-14T10:01:00Z"}'

# Watch for backend commands
mosquitto_sub -h 192.168.100.207 -t 'coop/door/cmd' -v

# Check the retained config is present
mosquitto_sub -h 192.168.100.207 -t 'coop/config' -v
```
