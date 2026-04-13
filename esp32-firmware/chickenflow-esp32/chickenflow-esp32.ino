/*
 * ChickenFlow ESP32-S2 Mini Firmware
 * ─────────────────────────────────────────────────────────────────────────────
 * Board : LOLIN / Wemos ESP32-S2 Mini
 * Core  : esp32 by Espressif >= 3.0.0 (Arduino IDE Board Manager)
 *
 * Required libraries (Library Manager):
 *   - WiFiManager  by tzapu          >= 2.0.17
 *   - ArduinoJson  by Benoit Blanchon >= 7.0.0
 *
 * Hardware present in this revision:
 *   - L298N motor driver (door open/close)
 *   - Top limit switch (door fully open detection)
 *   - Passive buzzer, status LED, coop light relay
 *
 * Not yet wired — firmware stubs these fields so the backend still accepts
 * sensor payloads:
 *   - HC-SR04 ultrasonic (obstruction detection)
 *   - IR beam break (chicken counter)
 *
 * Door logic:
 *   OPEN  — motor drives OPEN until PIN_TOP_SENSOR reads LOW, else timeout → ERROR.
 *   CLOSE — motor drives CLOSE for DOOR_TRAVEL_MS then declares CLOSED.
 *
 * Coop light:
 *   Controlled via backend command actions LIGHT_ON / LIGHT_OFF polled from
 *   /api/esp32/command (same endpoint as door OPEN / CLOSE).
 *
 * First boot broadcasts "ChickenFlow-Setup" AP → 192.168.4.1 → enter WiFi.
 */

#include <WiFi.h>
#include <WiFiManager.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include "config.h"

// ─────────────────────────────────────────────────────────────────────────────
// Door state machine
// ─────────────────────────────────────────────────────────────────────────────
enum DoorState  { DOOR_OPEN, DOOR_CLOSED, DOOR_OPENING, DOOR_CLOSING, DOOR_ERROR };
enum MotorPhase { MOTOR_IDLE, MOTOR_MOVING };

DoorState  doorState         = DOOR_CLOSED;
MotorPhase motorPhase        = MOTOR_IDLE;
bool       motorIsOpening    = false;
String     motorPrevStr;
unsigned long motorPhaseStartMs = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Coop light
// ─────────────────────────────────────────────────────────────────────────────
bool coopLightOn = false;

// Buzzer stays silent until WiFi connects.
bool buzzerReady = false;

// Loop timers
unsigned long lastCommandPollMs = 0;
unsigned long lastSensorPostMs  = 0;

// ── Prototypes ───────────────────────────────────────────────────────────────
void   motorOpen();
void   motorClose();
void   motorStop();
void   startDoorMove(const char* direction);
void   tickDoorMotor();
void   setCoopLight(bool on);
void   reportDoorEvent(const char* fromState, const char* toState);
void   postSensorReading();
void   pollCommand();
String doorStateStr(DoorState s);
void   blinkLed(int times, int delayMs = 150);
void   tone(uint32_t freqHz, uint32_t durationMs);
void   playReady();
void   playDoorOpen();
void   playDoorClose();
void   playError();

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────
void setup() {
  DBG_BEGIN(115200);
  DBGLN("\n[ChickenFlow S2] Booting...");

  // Motor outputs LOW first
  pinMode(PIN_MOTOR_OPEN,  OUTPUT); digitalWrite(PIN_MOTOR_OPEN,  LOW);
  pinMode(PIN_MOTOR_CLOSE, OUTPUT); digitalWrite(PIN_MOTOR_CLOSE, LOW);

  // Top limit switch — internal pull-up, LOW = door fully open
  pinMode(PIN_TOP_SENSOR, INPUT_PULLUP);

  // Status LED
  pinMode(PIN_LED_STATUS, OUTPUT); digitalWrite(PIN_LED_STATUS, LOW);

  // Coop light relay — off at boot
  pinMode(PIN_COOP_LIGHT, OUTPUT); digitalWrite(PIN_COOP_LIGHT, LOW);

  // Buzzer — LEDC new API (core 3.x). Start silent.
  ledcAttach(PIN_BUZZER, LEDC_BUZZER_FREQ_INIT, LEDC_BUZZER_RESOLUTION);
  ledcWriteTone(PIN_BUZZER, 0);

  // Boot door state from top limit switch
  if (digitalRead(PIN_TOP_SENSOR) == LOW) {
    doorState = DOOR_OPEN;
    DBGLN("[Door] Boot state: OPEN (top limit active)");
  } else {
    doorState = DOOR_CLOSED;
    DBGLN("[Door] Boot state: CLOSED (top limit not active)");
  }

  // WiFiManager — blocks until connected or AP timeout
  WiFiManager wm;
  wm.setConfigPortalTimeout(180);
  blinkLed(2);
  if (!wm.autoConnect(WIFI_AP_NAME, WIFI_AP_PASS)) {
    DBGLN("[WiFi] Config timeout — rebooting");
    ESP.restart();
  }
  DBGF("[WiFi] Connected: %s  IP: %s\n",
    WiFi.SSID().c_str(), WiFi.localIP().toString().c_str());

  buzzerReady = true;
  playReady();

  DBGLN("[ChickenFlow S2] Ready.");
}

// ─────────────────────────────────────────────────────────────────────────────
// Main loop
// ─────────────────────────────────────────────────────────────────────────────
void loop() {
  unsigned long now = millis();

  if (WiFi.status() != WL_CONNECTED) {
    DBGLN("[WiFi] Reconnecting...");
    WiFi.reconnect();
    delay(3000);
    return;
  }

  tickDoorMotor();

  if (now - lastCommandPollMs >= COMMAND_POLL_MS) {
    lastCommandPollMs = now;
    pollCommand();
  }

  if (now - lastSensorPostMs >= SENSOR_POST_MS) {
    lastSensorPostMs = now;
    postSensorReading();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Command poll — GET /api/esp32/command
// ─────────────────────────────────────────────────────────────────────────────
void pollCommand() {
  HTTPClient http;
  http.begin(API_COMMAND);
  http.setTimeout(HTTP_TIMEOUT_MS);

  int code = http.GET();
  if (code != 200) {
    DBGF("[Command] HTTP %d\n", code);
    http.end();
    return;
  }

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, http.getString());
  http.end();

  if (err) {
    DBGF("[Command] JSON parse error: %s\n", err.c_str());
    return;
  }

  const char* action = doc["action"] | "NONE";
  DBGF("[Command] action=%s\n", action);

  if (strcmp(action, "OPEN") == 0 && doorState != DOOR_OPEN && motorPhase == MOTOR_IDLE) {
    startDoorMove("OPEN");
  } else if (strcmp(action, "CLOSE") == 0 && doorState != DOOR_CLOSED && motorPhase == MOTOR_IDLE) {
    startDoorMove("CLOSE");
  } else if (strcmp(action, "LIGHT_ON") == 0) {
    setCoopLight(true);
  } else if (strcmp(action, "LIGHT_OFF") == 0) {
    setCoopLight(false);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Door movement — non-blocking state machine
// ─────────────────────────────────────────────────────────────────────────────
void startDoorMove(const char* direction) {
  motorIsOpening = (strcmp(direction, "OPEN") == 0);
  motorPrevStr   = doorStateStr(doorState);
  doorState      = motorIsOpening ? DOOR_OPENING : DOOR_CLOSING;
  motorPhaseStartMs = millis();
  motorPhase     = MOTOR_MOVING;

  DBGF("[Door] Moving %s\n", direction);
  if (motorIsOpening) motorOpen();
  else                motorClose();
}

void tickDoorMotor() {
  if (motorPhase != MOTOR_MOVING) return;

  unsigned long now     = millis();
  unsigned long elapsed = now - motorPhaseStartMs;

  if (motorIsOpening) {
    // Success when top limit switch triggers (pulled LOW)
    if (digitalRead(PIN_TOP_SENSOR) == LOW) {
      motorStop();
      reportDoorEvent(motorPrevStr.c_str(), "OPEN");
      doorState  = DOOR_OPEN;
      motorPhase = MOTOR_IDLE;
      playDoorOpen();
      DBGLN("[Door] Reached OPEN (top limit)");
      return;
    }
    if (elapsed >= DOOR_TRAVEL_MS) {
      motorStop();
      doorState  = DOOR_ERROR;
      reportDoorEvent(motorPrevStr.c_str(), "ERROR");
      motorPhase = MOTOR_IDLE;
      playError();
      blinkLed(5, 300);
      DBGLN("[Door] TIMEOUT opening — limit switch not reached");
    }
  } else {
    // CLOSING: pure timed close until ultrasonic is wired.
    if (elapsed >= DOOR_TRAVEL_MS) {
      motorStop();
      reportDoorEvent(motorPrevStr.c_str(), "CLOSED");
      doorState  = DOOR_CLOSED;
      motorPhase = MOTOR_IDLE;
      playDoorClose();
      DBGLN("[Door] CLOSED (timed)");
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Motor control
// ─────────────────────────────────────────────────────────────────────────────
void motorOpen() {
  digitalWrite(PIN_MOTOR_OPEN,  HIGH);
  digitalWrite(PIN_MOTOR_CLOSE, LOW);
}

void motorClose() {
  digitalWrite(PIN_MOTOR_OPEN,  LOW);
  digitalWrite(PIN_MOTOR_CLOSE, HIGH);
}

void motorStop() {
  digitalWrite(PIN_MOTOR_OPEN,  LOW);
  digitalWrite(PIN_MOTOR_CLOSE, LOW);
}

// ─────────────────────────────────────────────────────────────────────────────
// Coop light relay
// ─────────────────────────────────────────────────────────────────────────────
void setCoopLight(bool on) {
  coopLightOn = on;
  digitalWrite(PIN_COOP_LIGHT, on ? HIGH : LOW);
  DBGF("[Light] %s\n", on ? "ON" : "OFF");
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/esp32/sensor
// ─────────────────────────────────────────────────────────────────────────────
void postSensorReading() {
  bool topActive = (digitalRead(PIN_TOP_SENSOR) == LOW);

  JsonDocument doc;
  // Ultrasonic not wired yet — send null so the backend stores NULL.
  doc["distanceCm"]         = nullptr;
  doc["topSensorTriggered"] = topActive;
  doc["irTriggered"]        = false;   // IR beam not wired yet
  doc["chickensInside"]     = 0;       // no counter until IR is wired
  doc["totalChickens"]      = 0;       // backend fills from settings
  doc["doorState"]          = doorStateStr(doorState);

  String body;
  serializeJson(doc, body);

  HTTPClient http;
  http.begin(API_SENSOR);
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.addHeader("Content-Type", "application/json");

  int code = http.POST(body);
  DBGF("[Sensor] POST %d  top=%d  door=%s\n",
       code, topActive ? 1 : 0, doorStateStr(doorState).c_str());
  http.end();
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/esp32/door-event
// ─────────────────────────────────────────────────────────────────────────────
void reportDoorEvent(const char* fromState, const char* toState) {
  JsonDocument doc;
  doc["fromState"]      = fromState;
  doc["toState"]        = toState;
  doc["chickensInside"] = 0;

  String body;
  serializeJson(doc, body);

  HTTPClient http;
  http.begin(API_DOOR_EVENT);
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.addHeader("Content-Type", "application/json");

  int code = http.POST(body);
  DBGF("[Door] Event %s→%s  HTTP %d\n", fromState, toState, code);
  http.end();
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
String doorStateStr(DoorState s) {
  switch (s) {
    case DOOR_OPEN:    return "OPEN";
    case DOOR_CLOSED:  return "CLOSED";
    case DOOR_OPENING: return "OPENING";
    case DOOR_CLOSING: return "CLOSING";
    case DOOR_ERROR:   return "ERROR";
    default:           return "UNKNOWN";
  }
}

void blinkLed(int times, int delayMs) {
  for (int i = 0; i < times; i++) {
    digitalWrite(PIN_LED_STATUS, HIGH);
    delay(delayMs);
    digitalWrite(PIN_LED_STATUS, LOW);
    delay(delayMs);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Passive buzzer — LEDC square wave (Arduino-ESP32 core 3.x API)
// ─────────────────────────────────────────────────────────────────────────────
// Single blocking tone. Safe in event handlers (durations 80–400 ms).
// Silently skipped until buzzerReady = true (set after WiFi connects).
void tone(uint32_t freqHz, uint32_t durationMs) {
  if (!buzzerReady) return;
  ledcWriteTone(PIN_BUZZER, freqHz);
  delay(durationMs);
  ledcWriteTone(PIN_BUZZER, 0);
}

void playReady() {
  tone(NOTE_C5, 100); delay(40);
  tone(NOTE_E5, 100); delay(40);
  tone(NOTE_G5, 150);
}

void playDoorOpen() {
  tone(NOTE_C5, 80); delay(30);
  tone(NOTE_G5, 120);
}

void playDoorClose() {
  tone(NOTE_G5, 80); delay(30);
  tone(NOTE_C5, 120);
}

void playError() {
  tone(NOTE_G4, 150); delay(40);
  tone(NOTE_E4, 150); delay(40);
  tone(NOTE_C4, 300);
}
