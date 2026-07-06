# ChickenFlow ESP32-S2 Mini Firmware

## Hardware

**Board**: LOLIN ESP32-S2 Mini  
**Sensor**: Dual IR beam pair (directional chicken counting)  
**Sensor**: INA219 (I2C) — motor current monitoring for stall/obstruction detection  
**Sensor**: BME280 (I2C) — barometric pressure for local storm fallback  
**RTC**: DS3231 (I2C) — autonomous timekeeping  
**Motor driver**: L298N H-bridge (12V door motor)  
**Limit switches**: 2× NO (normally-open) — top + bottom positions

### Wiring

See `config.h` for the full GPIO map. Summary:

```
ESP32-S2 Mini     Peripheral
─────────────     ────────────────────────────────
GPIO  5      →    L298N IN1  (door OPEN direction)
GPIO  7      →    L298N IN2  (door CLOSE direction)
GPIO  6      →    L298N ENA  (PWM soft-start)
GPIO  9      →    IR beam A — yard side
GPIO 10      →    IR beam B — coop side
GPIO 12      →    Limit switch TOP   (NO, 10kΩ pull-up)
GPIO  8      →    Limit switch BOTTOM (NO, 10kΩ pull-up)
GPIO 33/35   →    I2C SDA/SCL (DS3231 RTC + INA219 + BME280)
GPIO 14      →    Passive buzzer (LEDC PWM)
GPIO 15      →    Status LED (built-in)
GPIO 16      →    Coop light / spare output

12V DC       →    Motor + 3.3V regulated for ESP32 and sensors
```

> **Serial**: ESP32-S2 uses native USB CDC — no UART pin conflict.

---

## Build & Flash (PlatformIO)

```bash
cd esp32-firmware/chickenflow-esp32-s2
pio run                  # Build only
pio run -t upload        # Build + flash via USB
pio device monitor       # Serial monitor (115200 baud)
```

Board: `lolin_s2_mini` (see `platformio.ini`).  
The ESP32-S2 Mini has native USB — plug in and flash directly, no FTDI needed.

---

## First Boot — WiFi Setup

On first boot the ESP32 broadcasts a WiFi AP:
- **SSID**: `ChickenFlow-Setup`
- **Password**: `chickenflow`

1. Connect your phone/laptop to this AP
2. Navigate to `http://192.168.4.1`
3. Click "Configure WiFi"
4. Enter your home network SSID and password
5. The ESP32 saves credentials to flash and reboots

**To force re-config** (e.g. new router): hold GPIO 0 LOW for 3 seconds on boot.

---

## Configuration

Edit `config.h` before flashing:

```cpp
// ← Set this to your MetalLB IP or k3s node IP
#define SERVER_HOST   "http://192.168.1.50"
#define SERVER_PORT   80   // 80 (MetalLB) or 30400 (NodePort)

// Timing
#define COMMAND_POLL_MS   5000   // How often to poll for door commands
#define SENSOR_POST_MS   10000   // How often to send sensor readings
#define CAPTURE_POST_MS  60000   // How often to upload a camera frame

// Door
#define DOOR_TRAVEL_MS   12000   // Max travel time — adjust for your motor
// Obstruction: INA219 stall current (see config.h for thresholds)
```

---

## Behaviour

### Boot sequence
1. Read limit switches → determine initial door state
2. Connect WiFi (via saved credentials or AP config portal)
3. Connect MQTT broker (192.168.100.207) → receive retained `coop/config`, publish `coop/door/status` (`last_event: "boot"`)
4. 3 quick LED blinks = ready

### Main loop (every iteration)
- IR tunnel beams: debounced A→B / B→A sequence detection → publish one `coop/count` (`dir: IN|OUT`, QoS 1) per transit
- MQTT loop: execute `coop/door/cmd` on arrival; publish `coop/door/status` (retained, QoS 1) on every transition
- Every 60s (`MQTT_TELEMETRY_INTERVAL_MS`): publish `coop/telemetry` (temp, current, voltage, RSSI, uptime, light level)
- Broker lost > 5 min (`MQTT_AUTONOMY_GRACE_MS`): autonomous fallback — local solar schedule from DS3231 + retained config

### Door movement
1. Energise motor (soft-start via PWM ramp)
2. Poll limit switch + INA219 current each cycle
3. During CLOSE: INA219 monitors for stall current pattern (obstruction)
   - If stall detected: stop, re-open, wait 30s, retry (max 3×) — hardware-authoritative, no backend round-trip
   - After 3 failures: report ERROR state, stop
4. On limit switch hit: stop motor, report door event to backend
5. Travel timeout (15s default): stop motor, report ERROR

### LED status
| Phase | Pattern | Meaning |
|-------|---------|---------|
| Boot | Rapid blink | Connecting to WiFi |
| Connected | Solid ON 3s | WiFi connected confirmation |
| Running | Constant ON | System healthy, normal operation |
| Data transfer | Brief OFF flicker | MQTT publish (HDD-style) |
| Error | 5 fast blinks | Door travel timeout |
| Error | 6 medium blinks | Obstruction max retries — door in ERROR |

---

## Backend contract (MQTT only)

The firmware makes **zero HTTP calls**. The full topic contract (payload
schemas, QoS, retain flags) lives in `chickenFlow/docs/mqtt-schema.md` — keep
it, `src/config.h`, and the backend's `mqtt-bridge.service.ts` in lock-step.

| Topic | Dir | Purpose |
|-------|-----|---------|
| `coop/telemetry` | ESP → broker | 60 s health ping (QoS 0) |
| `coop/count` | ESP → broker | one message per IR-tunnel transit (QoS 1) |
| `coop/door/status` | ESP → broker | every door transition (QoS 1, retained) |
| `coop/door/cmd` | broker → ESP | door commands from UI/automation (QoS 1) |
| `coop/config` | broker → ESP | retained config: lat/lon, tz offset, travel watchdog |
