# ChickenFlow ESP32-CAM Firmware

## Hardware

**Board**: AI Thinker ESP32-CAM  
**Sensor**: HC-SR04 ultrasonic (distance/obstruction)  
**Sensor**: IR beam break (chicken counting)  
**Motor driver**: L298N (or any 2-pin IN1/IN2 H-bridge)  
**Limit switches**: 2× NO (normally-open) microswitches

### Wiring

```
ESP32-CAM         Peripheral
─────────────     ────────────────────────────────
GPIO 12      →    HC-SR04 TRIG
GPIO 13      →    HC-SR04 ECHO
GPIO 14      →    IR sensor OUT  (sensor VCC → 3.3V, GND → GND)
GPIO 15      →    L298N IN1  (door OPEN direction)
GPIO 16      →    L298N IN2  (door CLOSE direction)
GPIO  2      →    Status LED (onboard)
GPIO  3      →    Limit switch OPEN  (other pin → GND)
GPIO  1      →    Limit switch CLOSE (other pin → GND)

3.3V / GND   →    HC-SR04 VCC / GND
5V  / GND    →    L298N VCC / GND  (separate 5V supply for motor)
```

> **GPIO 12 note**: Must be LOW at boot or the ESP32 fails to start.
> The HC-SR04 TRIG is only driven HIGH during measurement — safe.

> **GPIO 1 & 3 note**: These are UART TX/RX. The sketch uses `Serial.begin(115200)`
> for debugging — limit switches will cause noise on serial during door movement.
> Disable serial output in production by removing `Serial.begin()` and all
> `Serial.print*` calls.

---

## Arduino IDE Setup

### 1. Install ESP32 board support

In Arduino IDE → Preferences → Additional Board Manager URLs, add:
```
https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
```

Then: Tools → Board Manager → search **esp32** → install **esp32 by Espressif Systems** ≥ 2.0.17

### 2. Install libraries

Tools → Manage Libraries:
- **WiFiManager** by tzapu ≥ 2.0.17
- **ArduinoJson** by Benoit Blanchon ≥ 7.0.0

### 3. Board settings

```
Board            : AI Thinker ESP32-CAM
Partition Scheme : Huge APP (3MB No OTA / 1MB SPIFFS)
Flash Mode       : QIO
Flash Frequency  : 80MHz
Upload Speed     : 115200
```

---

## Flashing

The AI Thinker ESP32-CAM has **no USB**. You need an FTDI FT232RL adapter (3.3V logic).

```
FTDI        ESP32-CAM
────────    ─────────
TX      →   RX  (GPIO 3)
RX      →   TX  (GPIO 1)
GND     →   GND
3.3V    →   3.3V  (or use separate 5V supply via VCC pin)
```

**To enter flash mode**: hold GPIO 0 LOW (bridge IO0 to GND), then press reset.  
**After flash**: remove the GPIO 0 bridge, press reset — it boots normally.

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
#define OBSTRUCTION_CM      20   // Distance below this = obstruction
```

---

## Behaviour

### Boot sequence
1. Read limit switches → determine initial door state
2. Init camera
3. Connect WiFi (via saved credentials or AP config portal)
4. 3 quick LED blinks = ready

### Main loop (every iteration)
- IR sensor: debounced pulse counting → updates `chickensInside`
- Every 5s: `GET /api/esp32/command` → execute OPEN or CLOSE if pending
- Every 10s: `POST /api/esp32/sensor` → distance, IR state, chicken count, door state
- Every 60s: `POST /api/esp32/capture` → JPEG image (backend resizes + AI analysis)

### Door movement
1. Energise motor
2. Poll limit switch every 50ms
3. During CLOSE: measure ultrasonic distance every cycle
   - If < 20cm: stop, re-open, wait 30s, retry (max 3×)
   - After 3 failures: report ERROR state, stop
4. On limit switch hit: stop motor, report door event to backend
5. Travel timeout (12s default): stop motor, report ERROR

### LED codes
| Pattern | Meaning |
|---------|---------|
| 2 blinks on boot | Starting WiFi config |
| 3 quick blinks | Ready |
| 1 blink | Door reached target |
| 3 slow blinks | Camera init failed |
| 5 fast blinks | Door travel timeout |
| 6 medium blinks | Obstruction max retries — door in ERROR |

---

## API Endpoints Used

All requests go to `SERVER_HOST` (plain HTTP, no TLS):

| Method | Path | Payload | Purpose |
|--------|------|---------|---------|
| `GET` | `/api/esp32/command` | — | Poll for door command. Response: `{"action":"OPEN\|CLOSE\|NONE","delay":0}`. Server resets to NONE after delivery. |
| `POST` | `/api/esp32/sensor` | JSON | `distanceCm, irTriggered, chickensInside, totalChickens, doorState` |
| `POST` | `/api/esp32/capture` | multipart | `image` field (JPEG, max 4MB). Backend resizes → 800px, triggers Claude vision analysis. |
| `POST` | `/api/esp32/door-event` | JSON | `fromState, toState, chickensInside` |
