#pragma once

// ─────────────────────────────────────────────────────────────────────────────
// ChickenFlow ESP32-S2 Mini — Hardware & Network Configuration
// ─────────────────────────────────────────────────────────────────────────────
//
// Board: ESP32-S2 Mini (LOLIN S2 Mini / similar)
// Arduino core: esp32 by Espressif
//
// Transport: MQTT to mosquitto broker on k3s (hydroflow namespace).
// Autonomy:  DS3231 RTC + local solar calc (Dusk2Dawn). Backend is override-only.
// Safety:    Dual limit switches + INA219 stall current + dual IR tunnel.

// ── Pin assignments ───────────────────────────────────────────────────────────
// Motor (L298N H-bridge)
#define PIN_MOTOR_OPEN         5    // IN1 — HIGH = open direction
#define PIN_MOTOR_CLOSE        7    // IN2 — HIGH = close direction
#define PIN_MOTOR_PWM          6    // ENA — LEDC PWM for soft-start/stop

// Limit switches (NO, INPUT_PULLUP: LOW when triggered)
#define PIN_LIMIT_TOP         12    // LOW = door fully open
#define PIN_LIMIT_BOTTOM       8    // LOW = door fully closed

// IR tunnel (dual beam, LOW = broken)
#define PIN_IR_SENSOR_A        9    // Yard-side beam
#define PIN_IR_SENSOR_B       10    // Coop-side beam

// I²C bus (shared by DS3231 RTC + INA219 current sensor)
#define PIN_I2C_SDA           33
#define PIN_I2C_SCL           35
#define I2C_ADDR_DS3231     0x68
#define I2C_ADDR_INA219     0x40

// UI / alerts
#define PIN_BUZZER            14    // Passive buzzer — LEDC PWM
#define PIN_LED_STATUS        15
#define PIN_COOP_LIGHT        16    // Service-mode indicator LED (HIGH = serviceMode on)

// Manual override button — NO, wired between GPIO and GND (INPUT_PULLUP).
// 5s press  = door OPEN for 15 min (override), two short chirps.
// 10s press = service mode ON + door OPEN, one 2 s tone.
#define PIN_MANUAL_BUTTON     13
#define BUTTON_DEBOUNCE_MS             50
#define BUTTON_PRESS_OVERRIDE_MS     5000
#define BUTTON_PRESS_SERVICE_MS     10000
#define SERVICE_MODE_REMINDER_MS   300000   // Chirp every 5 min while in service mode

// ── LEDC channels ────────────────────────────────────────────────────────────
#define LEDC_BUZZER_CHANNEL     0
#define LEDC_BUZZER_RESOLUTION  8
#define LEDC_BUZZER_FREQ_INIT   2000

#define LEDC_MOTOR_CHANNEL      1
#define LEDC_MOTOR_RESOLUTION   8       // 0..255 duty
#define LEDC_MOTOR_FREQ         20000   // 20 kHz — above audible range

// ── Motor soft-start profile ─────────────────────────────────────────────────
#define MOTOR_DUTY_MAX          255
#define MOTOR_RAMP_UP_MS        1000    // Linear accel — long enough to mask INA219 inrush
#define MOTOR_RAMP_DOWN_MS       500    // Short decel — precise stop at limit switches

// ── Musical note frequencies (Hz) ────────────────────────────────────────────
#define NOTE_C4   262
#define NOTE_D4   294
#define NOTE_DS4  311
#define NOTE_E4   330
#define NOTE_F4   349
#define NOTE_G4   392
#define NOTE_A4   440
#define NOTE_C5   523
#define NOTE_E5   659
#define NOTE_G5   784

// ── MQTT broker (mosquitto.hydroflow on k3s, MetalLB LB IP) ──────────────────
#define MQTT_HOST          "192.168.100.207"
#define MQTT_PORT          1883
#define MQTT_CLIENT_ID     "chickenflow-esp32-s2"
#define MQTT_KEEPALIVE_S   30

// MQTT topics (see docs/mqtt-schema.md for payload contracts)
#define MQTT_T_TELEMETRY   "coop/telemetry"      // ESP → K3s, every 60s
#define MQTT_T_COUNT       "coop/count"          // ESP → K3s, on transit event
#define MQTT_T_DOOR_STATUS "coop/door/status"    // ESP → K3s, on state change
#define MQTT_T_DOOR_CMD    "coop/door/cmd"       // K3s → ESP
#define MQTT_T_CONFIG      "coop/config"         // K3s → ESP (OTA lat/lon/offset)

#define MQTT_TELEMETRY_INTERVAL_MS   60000

// ── WiFiManager AP (first-boot config portal) ────────────────────────────────
#define WIFI_AP_NAME       "ChickenFlow-Setup"
#define WIFI_AP_PASS       "chickenflow"
#define WIFI_AP_TIMEOUT_S  180

// ── Solar location (hardcoded default, OTA-overridable via coop/config) ──────
#define SOLAR_LAT_DEFAULT     43.5167   // Antonovo, BG
#define SOLAR_LON_DEFAULT     26.8333
#define SOLAR_TZ_OFFSET_MIN   120       // EET = UTC+2; DST handled in firmware
#define SOLAR_NUDGE_MIN       0         // Configurable open/close offset from sunrise/sunset

// ── Door mechanics ───────────────────────────────────────────────────────────
// Travel time is auto-calibrated on first full open→close cycle and stored in
// NVS (Preferences). 15000 ms is the hard watchdog until calibration completes.
#define DOOR_TRAVEL_MS_DEFAULT  15000
#define DOOR_TRAVEL_SAFETY_MULT 1.2     // Cycle > stored*mult → ERROR + alarm
#define DOOR_RETRY_MAX          3

// ── INA219 stall detection ───────────────────────────────────────────────────
// Calibrate on bench: measure free-run mA and stall mA.
// Threshold = free_run_ma + 0.5 * (stall_ma - free_run_ma)
// Placeholders until real bench values are recorded:
#define INA219_FREERUN_MA_DEFAULT   120
#define INA219_STALL_MA_DEFAULT     600
#define INA219_SAMPLE_WINDOW_MS     100    // Rolling window
#define INA219_INRUSH_MASK_MS      1100    // Ignore stall during ramp-up

// ── IR tunnel (directional counting + safety) ────────────────────────────────
// A = yard side, B = coop side.
//   A→B = IN  (yard → coop)
//   B→A = OUT (coop → yard)
#define IR_DEBOUNCE_MS         150
#define IR_TUNNEL_TIMEOUT_MS  2000    // Max gap between beams for a valid transit

// ── Obstruction recovery ─────────────────────────────────────────────────────
#define OBSTRUCTION_REVERSE_PCT   20     // Reverse 20% of travel
#define OBSTRUCTION_WAIT_MS    30000     // Wait before retry
#define OBSTRUCTION_BUZZ_MS     3000     // Clear-the-tunnel buzzer duration

// ── HTTP API fallback (used until MQTT migration is complete) ─────────────
// Server base URL — MetalLB or NodePort
#define SERVER_BASE        "http://192.168.100.211"
#define API_SENSOR         SERVER_BASE "/api/esp32/sensor"
#define API_COMMAND        SERVER_BASE "/api/esp32/command"
#define API_DOOR_EVENT     SERVER_BASE "/api/esp32/door-event"
#define API_OBSTRUCTION_CHECK  SERVER_BASE "/api/esp32/obstruction-check"

#define COMMAND_POLL_MS           5000
#define SENSOR_POST_MS           10000
#define HTTP_TIMEOUT_MS           5000
#define OBSTRUCTION_CHECK_TIMEOUT_MS 10000

// ── Status LED timing ───────────────────────────────────────────────────
#define LED_BLINK_CONNECTING_MS    80   // Rapid blink half-period during WiFi connect
#define LED_CONNECTED_PAUSE_MS   3000   // Solid ON pause after WiFi connects
#define LED_TRANSFER_FLICKER_MS    30   // Brief OFF duration per packet (HDD style)

// ── Logging ──────────────────────────────────────────────────────────────────
#define ENABLE_SERIAL  1   // Safe on ESP32-S2 via native USB CDC

#if ENABLE_SERIAL
  #define DBG_BEGIN(baud) Serial.begin(baud)
  #define DBG(...)        Serial.print(__VA_ARGS__)
  #define DBGLN(...)      Serial.println(__VA_ARGS__)
  #define DBGF(...)       Serial.printf(__VA_ARGS__)
#else
  #define DBG_BEGIN(baud) ((void)0)
  #define DBG(...)        ((void)0)
  #define DBGLN(...)      ((void)0)
  #define DBGF(...)       ((void)0)
#endif
