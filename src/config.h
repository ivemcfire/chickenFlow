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
#define PIN_IR_SENSOR         9    // LOW = chicken crossing beam
#define PIN_LIMIT_TOP        12    // LOW = door fully open (top limit switch)
#define PIN_BUZZER           14    // Passive buzzer — PWM output
#define PIN_LED_STATUS       15    // Status LED
#define PIN_COOP_LIGHT       16    // Optional coop light / spare output

// ── Optional camera support ──────────────────────────────────────────────────
#define USE_CAMERA           0    // 0 = no camera on ESP32-S2 Mini board

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
// Plain HTTP — the board sends unencrypted API and capture requests.
// SERVER_HOST = MetalLB IP (port 80) or NodePort address of the k3s service.
#define SERVER_HOST   "http://192.168.1.211"   // ← k3master MetalLB IP
#define SERVER_PORT   80

// ── Hardcoded WiFi credentials ─────────────────────────────────────────────────
#define WIFI_SSID      "Dom na Ayurveda"
#define WIFI_PASSWORD  "Ayurveda12"

// ENABLE_SERIAL is safe on ESP32-S2 Mini via USB CDC serial.
// Set to 1 to enable UART boot and runtime debug output.
#define ENABLE_SERIAL  1

#define API_SENSOR       SERVER_HOST "/api/esp32/sensor"
#define API_CAPTURE      SERVER_HOST "/api/esp32/capture"
#define API_DOOR_EVENT   SERVER_HOST "/api/esp32/door-event"
#define API_COMMAND      SERVER_HOST "/api/esp32/command"

// ── WiFiManager AP ────────────────────────────────────────────────────────────
// First boot: ESP32 broadcasts this AP. Connect → 192.168.4.1 → enter WiFi.
// Credentials saved to flash — one-time setup. Force re-config: hold GPIO 0
// LOW for 3 s on boot.
#define WIFI_AP_NAME  "ChickenFlow-Setup"
#define WIFI_AP_PASS  "chickenflow"

// ── Timing ────────────────────────────────────────────────────────────────────
#define COMMAND_POLL_MS    5000    // Poll /api/esp32/command
#define SENSOR_POST_MS    10000    // POST sensor readings
#define CAPTURE_POST_MS   60000    // POST camera image
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

// ── Chicken counting (IR) ─────────────────────────────────────────────────────
#define IR_DEBOUNCE_MS      300    // Ignore re-triggers within this window (ms)

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
