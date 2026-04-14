#pragma once

// ─────────────────────────────────────────────────────────────────────────────
// ChickenFlow ESP32-S2 Mini — Hardware & Network Configuration
// ─────────────────────────────────────────────────────────────────────────────
//
// Board: ESP32-S2 Mini (LOLIN S2 Mini / similar)
// Arduino core: esp32 by Espressif
//
// Safe GPIO map for ESP32-S2 Mini:
//   GPIO  5  → Motor IN1
//   GPIO  7  → Motor IN2
//   GPIO 12  → Top limit switch
//   GPIO 14  → Buzzer output
//   GPIO 15  → Status LED
//   GPIO 16  → Coop light / spare output
//
// Note: avoid using UART0 TX/RX pins for hardware outputs if you need serial debug.

// ── Pin assignments ───────────────────────────────────────────────────────────
#define PIN_MOTOR_OPEN        5    // HIGH = energise open direction   (L298N IN1)
#define PIN_MOTOR_CLOSE       7    // HIGH = energise close direction  (L298N IN2)
#define PIN_ULTRASONIC_TRIG   4    // Pulse HIGH 10 µs to trigger ultrasonic measurement
#define PIN_ULTRASONIC_ECHO   8    // Measures HIGH pulse duration ∝ distance
#define PIN_IR_SENSOR_A       9    // Tunnel beam A (coop side)  — LOW = broken
#define PIN_IR_SENSOR_B      10    // Tunnel beam B (yard side)  — LOW = broken
// Legacy single-beam alias (kept so any existing reference still compiles).
#define PIN_IR_SENSOR         PIN_IR_SENSOR_A
#define PIN_LIMIT_TOP        12    // LOW = door fully open (top limit switch)
#define PIN_BUZZER           14    // Passive buzzer — PWM output
#define PIN_LED_STATUS       15    // Status LED
#define PIN_COOP_LIGHT       16    // Optional coop light / spare output

// ── LEDC buzzer channel ─────────────────────────────────────────────────────
#define LEDC_BUZZER_CHANNEL    0
#define LEDC_BUZZER_RESOLUTION 8     // 8-bit; tone() only uses frequency, not duty
#define LEDC_BUZZER_FREQ_INIT  2000  // Hz — placeholder passed to ledcSetup()

// ── Musical note frequencies (Hz) ────────────────────────────────────────────
// Standard equal temperament. Used by the melody functions in the .ino.
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

// ── Backend server ────────────────────────────────────────────────────────────
// Plain HTTP to the chickenflow MetalLB IP on the k3s cluster.
#define SERVER_HOST   "http://192.168.100.211"
#define SERVER_PORT   80

// ENABLE_SERIAL is safe on ESP32-S2 Mini via native USB CDC serial.
#define ENABLE_SERIAL  1

#define API_SENSOR            SERVER_HOST "/api/esp32/sensor"
#define API_DOOR_EVENT        SERVER_HOST "/api/esp32/door-event"
#define API_COMMAND           SERVER_HOST "/api/esp32/command"
#define API_OBSTRUCTION_CHECK SERVER_HOST "/api/esp32/obstruction-check"

// ── WiFiManager AP (first-boot config portal) ────────────────────────────────
// On first boot — or whenever stored credentials fail — the board broadcasts
// this AP. Connect → 192.168.4.1 → enter home WiFi credentials. Saved to NVS.
#define WIFI_AP_NAME       "ChickenFlow-Setup"
#define WIFI_AP_PASS       "chickenflow"
#define WIFI_AP_TIMEOUT_S  180   // auto-reboot if portal is idle this long

// ── Timing ────────────────────────────────────────────────────────────────────
#define COMMAND_POLL_MS    5000    // Poll /api/esp32/command
#define SENSOR_POST_MS    10000    // POST sensor readings
#define HTTP_TIMEOUT_MS    8000    // HTTP request timeout

// ── Door motor ────────────────────────────────────────────────────────────────
// OPENING: motor runs until PIN_LIMIT_TOP goes LOW, or timeout → ERROR.
// CLOSING: motor runs for DOOR_TRAVEL_MS then declares CLOSED (no bottom
//          limit switch — timed close). Tune DOOR_TRAVEL_MS to your mechanism.
#define DOOR_TRAVEL_MS    12000    // Max stroke duration (ms)
#define DOOR_RETRY_MAX        3    // Max obstruction retries before ERROR

// ── Ultrasonic ────────────────────────────────────────────────────────────────
#define OBSTRUCTION_CM       20    // Distance < this = obstruction during close
#define ULTRASONIC_SAMPLES    5    // Median of N readings per measurement

// ── Chicken counting (dual-IR tunnel) ────────────────────────────────────────
// Two IR break-beams in a short tunnel. Event order gives direction:
//   A→B = OUT (coop → yard)
//   B→A = IN  (yard → coop)
// Any single beam trip with no follow-through inside IR_TUNNEL_TIMEOUT_MS
// is discarded (partial approach, leaf, etc.).
#define IR_DEBOUNCE_MS          150    // Per-beam debounce
#define IR_TUNNEL_TIMEOUT_MS   2000    // Max gap between beam A and beam B

// ── AI obstruction gate ──────────────────────────────────────────────────────
// After a local ultrasonic stop, the firmware asks the backend to verify.
// Backend runs Gemini vision on a Frigate snapshot and returns { abort }.
// abort=true (≥80% confidence) → go to ERROR immediately (skip retries).
// abort=false                  → resume close cycle (retry like normal).
#define OBSTRUCTION_CHECK_TIMEOUT_MS  10000

// ── Debug logging macros ──────────────────────────────────────────────────────
// ENABLE_SERIAL must stay 0 (GPIO 1 is buzzer hardware). These compile to
// nothing in production. Use network-based debugging instead.
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
