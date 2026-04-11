#pragma once

// ─────────────────────────────────────────────────────────────────────────────
// ChickenFlow ESP32-CAM — Hardware & Network Configuration
// ─────────────────────────────────────────────────────────────────────────────
//
// Board: AI Thinker ESP32-CAM
// Arduino core: esp32 by Espressif >= 2.0.17
//
// ┌─────────────────────────────────────────────────────────────┐
// │  AI Thinker ESP32-CAM — Available GPIO (camera active)     │
// │                                                             │
// │  GPIO 12  → HC-SR04 TRIG  (set LOW at boot or flash fails) │
// │  GPIO 13  → HC-SR04 ECHO                                   │
// │  GPIO 14  → IR sensor OUT (active-LOW, INPUT_PULLUP)       │
// │  GPIO 15  → Motor IN1  (door OPEN  direction)              │
// │  GPIO 16  → Motor IN2  (door CLOSE direction)              │
// │  GPIO  2  → Status LED  (HIGH = on, onboard)               │
// │                                                             │
// │  Limit switches (hardware pull-up recommended):             │
// │  GPIO  3  → Door OPEN  limit switch (RX0 — disable serial) │
// │  GPIO  1  → Door CLOSE limit switch (TX0 — disable serial) │
// │                                                             │
// │  WARNING: GPIO 0 = camera PWDN. Keep HIGH during normal    │
// │  operation; pull LOW only to enter flash mode.             │
// └─────────────────────────────────────────────────────────────┘

// ── Pin assignments ───────────────────────────────────────────────────────────
#define PIN_ULTRASONIC_TRIG   12
#define PIN_ULTRASONIC_ECHO   13
#define PIN_IR_SENSOR         14   // LOW = chicken detected
#define PIN_MOTOR_OPEN        15   // HIGH = energise open direction
#define PIN_MOTOR_CLOSE       16   // HIGH = energise close direction
#define PIN_LED_STATUS         2   // Onboard LED
#define PIN_LIMIT_OPEN         3   // LOW = door is fully open
#define PIN_LIMIT_CLOSE        1   // LOW = door is fully closed

// ── Backend server ────────────────────────────────────────────────────────────
// Set to your MetalLB IP or NodePort (http, NOT https — ESP32-CAM can't
// handle modern TLS). Update after first k3s deploy.
#define SERVER_HOST   "http://192.168.1.50"   // ← UPDATE THIS
#define SERVER_PORT   80                        // 80 (MetalLB) or 30400 (NodePort)

#define API_SENSOR       SERVER_HOST "/api/esp32/sensor"
#define API_CAPTURE      SERVER_HOST "/api/esp32/capture"
#define API_DOOR_EVENT   SERVER_HOST "/api/esp32/door-event"
#define API_COMMAND      SERVER_HOST "/api/esp32/command"

// ── WiFiManager AP ────────────────────────────────────────────────────────────
// On first boot (or after reset), the ESP32 creates a WiFi AP with this name.
// Connect to it, navigate to 192.168.4.1, enter your home WiFi credentials.
// Credentials are saved to flash — you only do this once.
#define WIFI_AP_NAME  "ChickenFlow-Setup"
#define WIFI_AP_PASS  "chickenflow"

// ── Timing ────────────────────────────────────────────────────────────────────
#define COMMAND_POLL_MS    5000    // How often to poll /api/esp32/command
#define SENSOR_POST_MS    10000    // How often to POST sensor readings
#define CAPTURE_POST_MS   60000    // How often to POST a camera image
#define HTTP_TIMEOUT_MS    8000    // HTTP request timeout

// ── Door motor ────────────────────────────────────────────────────────────────
#define DOOR_TRAVEL_MS    12000    // Max time allowed for full open/close stroke
#define DOOR_RETRY_MAX        3    // Obstruction retries before ERROR state

// ── Ultrasonic ────────────────────────────────────────────────────────────────
#define OBSTRUCTION_CM       20    // Distance below this = obstruction detected
#define ULTRASONIC_SAMPLES    5    // Median of N readings per measurement

// ── Chicken counting (IR) ─────────────────────────────────────────────────────
// IR sensor pulses LOW each time a chicken crosses the beam.
// The backend tracks counts — this just reports the raw pulse event.
#define IR_DEBOUNCE_MS      300
