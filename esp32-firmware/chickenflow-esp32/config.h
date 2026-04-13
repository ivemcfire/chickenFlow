#pragma once

// ─────────────────────────────────────────────────────────────────────────────
// ChickenFlow ESP32-S2 Mini — Hardware & Network Configuration
// ─────────────────────────────────────────────────────────────────────────────
//
// Board : LOLIN / Wemos ESP32-S2 Mini
// Core  : esp32 by Espressif >= 3.0.0 (required for the new LEDC API)
//
// ── Pin Assignments (safe, no strapping-pin conflicts on S2) ────────────────
//   GPIO  5 → Motor IN1   (OPEN  direction) — L298N
//   GPIO  7 → Motor IN2   (CLOSE direction) — L298N
//   GPIO 12 → Top limit switch   (INPUT_PULLUP, LOW = door fully open)
//   GPIO 14 → Passive buzzer     (LEDC square wave)
//   GPIO 15 → Status LED         (active HIGH)
//   GPIO 16 → Coop light relay   (active HIGH)
//
// Sensors intentionally omitted in this hardware revision:
//   - HC-SR04 ultrasonic (obstruction detection during close)
//   - IR beam-break (chicken counting)
// Video is sourced from the NETSurveillance cam01 via Frigate — the ESP32
// does not capture images.

// ── Pin assignments ───────────────────────────────────────────────────────────
#define PIN_MOTOR_OPEN     5
#define PIN_MOTOR_CLOSE    7
#define PIN_TOP_SENSOR    12
#define PIN_BUZZER        14
#define PIN_LED_STATUS    15
#define PIN_COOP_LIGHT    16

// ── LEDC buzzer (Arduino-ESP32 core 3.x API) ─────────────────────────────────
#define LEDC_BUZZER_RESOLUTION  8      // bits
#define LEDC_BUZZER_FREQ_INIT   2000   // Hz — placeholder passed to ledcAttach()

// ── Musical note frequencies (Hz) ────────────────────────────────────────────
#define NOTE_C4  262
#define NOTE_E4  330
#define NOTE_G4  392
#define NOTE_A4  440
#define NOTE_C5  523
#define NOTE_E5  659
#define NOTE_G5  784

// ── Backend server ────────────────────────────────────────────────────────────
// Plain HTTP to the chickenflow MetalLB IP on the k3s cluster.
#define SERVER_HOST      "http://192.168.100.211"
#define API_SENSOR       SERVER_HOST "/api/esp32/sensor"
#define API_DOOR_EVENT   SERVER_HOST "/api/esp32/door-event"
#define API_COMMAND      SERVER_HOST "/api/esp32/command"

// ── WiFiManager AP (first-boot config portal) ────────────────────────────────
// Connect to this AP → 192.168.4.1 → enter home WiFi credentials.
#define WIFI_AP_NAME  "ChickenFlow-Setup"
#define WIFI_AP_PASS  "chickenflow"

// ── Timing ────────────────────────────────────────────────────────────────────
#define COMMAND_POLL_MS    5000
#define SENSOR_POST_MS    10000
#define HTTP_TIMEOUT_MS    8000

// ── Door motor ────────────────────────────────────────────────────────────────
// OPENING: runs until PIN_TOP_SENSOR goes LOW, or DOOR_TRAVEL_MS elapses → ERROR.
// CLOSING: pure timed close for DOOR_TRAVEL_MS — no obstruction detection
//          until ultrasonic is wired.
#define DOOR_TRAVEL_MS   12000

// ── Debug logging ─────────────────────────────────────────────────────────────
// ESP32-S2 has native USB CDC — Serial does not collide with any GPIO.
#define ENABLE_SERIAL  1

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
