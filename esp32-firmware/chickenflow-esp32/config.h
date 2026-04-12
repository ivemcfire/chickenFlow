#pragma once

// ─────────────────────────────────────────────────────────────────────────────
// ChickenFlow ESP32-CAM — Hardware & Network Configuration
// ─────────────────────────────────────────────────────────────────────────────
//
// Board: AI Thinker ESP32-CAM
// Arduino core: esp32 by Espressif >= 2.0.17
//
// ┌───────────────────────────────────────────────────────────────────────────┐
// │  AI Thinker ESP32-CAM — Pin Assignment (No Serial, camera active)        │
// │                                                                           │
// │  GPIO 12 → Motor IN1  (OPEN  direction)  ← strapping pin; must be LOW   │
// │             at boot. L298N must not pull this HIGH during power-up.      │
// │  GPIO 13 → Motor IN2  (CLOSE direction)  safe output (HS_DATA)           │
// │  GPIO 15 → HC-SR04 TRIG                  ← strapping pin (MTDO);         │
// │             must be LOW at boot. HC-SR04 TRIG is a passive input,        │
// │             so it will not pull the ESP32 pin — safe.                    │
// │  GPIO 14 → HC-SR04 ECHO                  INPUT (HS_CLK, safe)            │
// │  GPIO  2 → IR sensor OUT (active-LOW)    ← strapping pin; must be        │
// │             LOW/floating at boot. Requires external 10kΩ pull-DOWN to   │
// │             GND. Never use INPUT_PULLUP on this pin.                     │
// │  GPIO  3 → Top limit switch (door OPEN)  INPUT with external 10kΩ        │
// │             pull-up to 3.3V (NO — Normally Open). HIGH=traveling,        │
// │             LOW=door fully open (limit triggered). RX pin — Serial off.  │
// │  GPIO  1 → Passive buzzer (PWM via LEDC) TX pin; boot ROM emits noise   │
// │             on this pin. Add transistor switch or RC low-pass filter.    │
// │             Firmware holds LEDC at 0 Hz until buzzerReady=true.          │
// │             ENABLE_SERIAL must stay 0 permanently — pin is hardware.     │
// │  GPIO  4 → Flash LED (status blink)      Onboard white flash LED;        │
// │             very bright — use short blink durations only.                │
// │                                                                           │
// │  NOTE: GPIO 0 = camera XCLK source. Keep HIGH during normal operation.  │
// │  NOTE: GPIO 16 is free — reserved for future expansion.                  │
// └───────────────────────────────────────────────────────────────────────────┘

// ── Pin assignments ───────────────────────────────────────────────────────────
#define PIN_MOTOR_OPEN        12   // HIGH = energise open direction   (L298N IN1)
#define PIN_MOTOR_CLOSE       13   // HIGH = energise close direction  (L298N IN2)
#define PIN_ULTRASONIC_TRIG   15   // Pulse HIGH 10 µs to trigger measurement
#define PIN_ULTRASONIC_ECHO   14   // Measures HIGH pulse duration ∝ distance
#define PIN_IR_SENSOR          2   // LOW = chicken crossing beam  (NO INPUT_PULLUP)
#define PIN_LIMIT_TOP          3   // LOW = door fully open (top limit, RX pin)
#define PIN_BUZZER             1   // Passive buzzer — LEDC square wave (TX pin)
#define PIN_LED_STATUS         4   // Onboard flash LED — blink for status

// ── LEDC buzzer channel ───────────────────────────────────────────────────────
// Channel 0 is reserved by esp_camera for XCLK. Use channel 1+.
#define LEDC_BUZZER_CHANNEL    1
#define LEDC_BUZZER_RESOLUTION 8     // 8-bit; tone() only uses frequency, not duty
#define LEDC_BUZZER_FREQ_INIT  2000  // Hz — placeholder passed to ledcSetup()

// ── Musical note frequencies (Hz) ────────────────────────────────────────────
// Standard equal temperament. Used by the melody functions in the .ino.
#define NOTE_C4   262
#define NOTE_E4   330
#define NOTE_G4   392
#define NOTE_A4   440
#define NOTE_C5   523
#define NOTE_E5   659
#define NOTE_G5   784

// ── Backend server ────────────────────────────────────────────────────────────
// Plain HTTP — ESP32-CAM cannot handle modern TLS.
// SERVER_HOST = MetalLB IP (port 80) or NodePort address of the k3s service.
#define SERVER_HOST   "http://192.168.1.211"   // ← k3master MetalLB IP
#define SERVER_PORT   80

// ENABLE_SERIAL must stay 0 permanently — GPIO 1 (TX) is the buzzer.
// Use the built-in web status page or Telnet for debug output instead.
#define ENABLE_SERIAL  0

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
