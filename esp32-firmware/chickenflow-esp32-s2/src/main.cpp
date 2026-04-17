#include <Arduino.h>
/*
 * ChickenFlow ESP32-S2 Mini Firmware
 * ─────────────────────────────────────────────────────────────────────────────
 * Board   : ESP32-S2 Mini (LOLIN S2 Mini / similar)
 * Core    : esp32 by Espressif
 *
 * Required libraries:
 *   - ArduinoJson  by Benoit Blanchon >= 7.0.0
 *
 * Wiring summary (see config.h for full GPIO map):
 *   Motor IN1    → GPIO  5   Motor IN2     → GPIO  7
 *   IR-A (yard)  → GPIO  9   IR-B (coop)  → GPIO 10
 *   Top limit    → GPIO 12   Bottom limit → GPIO  8
 *   Buzzer       → GPIO 14   Status LED   → GPIO 15
 *   Coop light   → GPIO 16   INA219 (I2C) → SDA 33 / SCL 35
 */

#include <WiFi.h>
#include <WiFiManager.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include "config.h"
#include "music.h"

// ─────────────────────────────────────────────────────────────────────────────
// Door state machine
// ─────────────────────────────────────────────────────────────────────────────
enum DoorState { DOOR_OPEN, DOOR_CLOSED, DOOR_OPENING, DOOR_CLOSING, DOOR_ERROR };

// Motor sub-states for non-blocking movement
enum MotorPhase { MOTOR_IDLE, MOTOR_MOVING, MOTOR_REOPEN, MOTOR_PAUSE, MOTOR_RETRY };

DoorState  doorState          = DOOR_CLOSED;
DoorState  prevReportedState  = DOOR_CLOSED;
uint8_t    obstructionRetries = 0;

// Non-blocking door movement state
MotorPhase    motorPhase        = MOTOR_IDLE;
bool          motorIsOpening    = false;
String        motorPrevStr;            // door state string before movement started
unsigned long motorPhaseStartMs = 0;   // when the current phase began

// ─────────────────────────────────────────────────────────────────────────────
// Chicken counter — dual-IR tunnel state machine
// Beam A = coop-side  |  Beam B = yard-side
// A→B = OUT,  B→A = IN
// ─────────────────────────────────────────────────────────────────────────────
enum TunnelPhase { TUNNEL_IDLE, TUNNEL_A_FIRST, TUNNEL_B_FIRST };

volatile int  chickensInside   = 0;
TunnelPhase   tunnelPhase      = TUNNEL_IDLE;
unsigned long tunnelPhaseMs    = 0;   // when current phase began
bool          irAPrev          = HIGH;
bool          irBPrev          = HIGH;
unsigned long irALastEdgeMs    = 0;
unsigned long irBLastEdgeMs    = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Timers
// ─────────────────────────────────────────────────────────────────────────────
unsigned long lastCommandPollMs = 0;
unsigned long lastSensorPostMs  = 0;
unsigned long lastCapturePostMs = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Status LED — 3-phase indicator on built-in LED (GPIO 15)
//   CONNECTING:      rapid blink while WiFi is associating
//   CONNECTED_PAUSE: solid ON for 3 s after WiFi connects (visual confirmation)
//   IDLE:            constant ON — system healthy
//   TRANSFER:        brief OFF flickers mimicking HDD activity LED
// ─────────────────────────────────────────────────────────────────────────────
enum LedMode { LED_CONNECTING, LED_CONNECTED_PAUSE, LED_IDLE, LED_TRANSFER };
LedMode       ledMode         = LED_CONNECTING;
unsigned long ledPhaseStartMs = 0;
unsigned long ledLastToggleMs = 0;
bool          ledState        = false;
int           ledTransferFlickers = 0;   // remaining flicker count

// ─────────────────────────────────────────────────────────────────────────────
// Prototypes
// ─────────────────────────────────────────────────────────────────────────────
void     tickTunnelCounter();
bool     queryObstructionAbort();
void     motorOpen();
void     motorClose();
void     motorStop();
void     startDoorMove(const char* direction);
void     tickDoorMotor();
void     reportDoorEvent(const char* fromState, const char* toState);
void     postSensorReading();
void     pollCommand();
String   doorStateStr(DoorState s);
void     blinkLed(int times, int delayMs = 150);
void     lightOn();
void     lightOff();
void     setLight(bool on);
void     ledTick();
void     ledSetMode(LedMode mode);
void     ledFlicker();
void     playReady();
void     playDoorOpen();
void     playDoorClose();
void     playObstruction();
void     playError();

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────
void setup() {
  DBG_BEGIN(115200);
  DBGLN("\n[ChickenFlow] Booting...");

  // ── GPIO setup ─────────────────────────────────────────────────────────────
  // Motor outputs: drive LOW first to avoid unintended motion at boot.
  pinMode(PIN_MOTOR_OPEN,  OUTPUT);  digitalWrite(PIN_MOTOR_OPEN,  LOW);
  pinMode(PIN_MOTOR_CLOSE, OUTPUT);  digitalWrite(PIN_MOTOR_CLOSE, LOW);

  // Dual IR tunnel beams: LOW = beam broken.
  pinMode(PIN_IR_SENSOR_A, INPUT);
  pinMode(PIN_IR_SENSOR_B, INPUT);

  // Top limit switch: external 10kΩ pull-up to 3.3V (Normally Open config).
  // HIGH = door traveling, LOW = door fully open (limit triggered).
  pinMode(PIN_LIMIT_TOP, INPUT);

  // Status LED: keep off until needed.
  pinMode(PIN_LED_STATUS, OUTPUT);
  digitalWrite(PIN_LED_STATUS, LOW);

  // Coop light / spare output: keep off by default.
  pinMode(PIN_COOP_LIGHT, OUTPUT);
  digitalWrite(PIN_COOP_LIGHT, LOW);

  // Passive buzzer: configure LEDC but output 0 Hz (silent).
  // Boot ROM already sent noise on this pin; stay silent until WiFi connects.
  buzzerInit();

  // ── Determine door position from top limit switch ──────────────────────────
  // One limit switch only (top = open position).
  // If not triggered, assume CLOSED — safer than assuming OPEN.
  if (digitalRead(PIN_LIMIT_TOP) == LOW) {
    doorState = DOOR_OPEN;
    DBGLN("[Door] Boot state: OPEN (top limit active)");
  } else {
    doorState = DOOR_CLOSED;
    DBGLN("[Door] Boot state: CLOSED (assumed — top limit not active)");
  }
  prevReportedState = doorState;

  // ── WiFi via WiFiManager — captive-portal fallback on first boot ──────────
  // Rapid blink while WiFi is connecting (blocking call — ledTick() won't run,
  // so we use a WiFiManager pre-loop callback to drive the blink manually).
  ledSetMode(LED_CONNECTING);

  WiFiManager wm;
  wm.setConfigPortalTimeout(WIFI_AP_TIMEOUT_S);
  wm.setWebServerCallback([&]() {
    // Called periodically during portal — keep the LED blinking
    unsigned long now = millis();
    if (now - ledLastToggleMs >= LED_BLINK_CONNECTING_MS) {
      ledLastToggleMs = now;
      ledState = !ledState;
      digitalWrite(PIN_LED_STATUS, ledState ? HIGH : LOW);
    }
  });

  // Pre-connect rapid blink (visible before autoConnect blocks)
  unsigned long blinkStart = millis();
  while (millis() - blinkStart < 2000) {
    unsigned long now = millis();
    if (now - ledLastToggleMs >= LED_BLINK_CONNECTING_MS) {
      ledLastToggleMs = now;
      ledState = !ledState;
      digitalWrite(PIN_LED_STATUS, ledState ? HIGH : LOW);
    }
    yield();
  }

  if (!wm.autoConnect(WIFI_AP_NAME, WIFI_AP_PASS)) {
    DBGLN("[WiFi] Config portal timed out — rebooting");
    ESP.restart();
  }

  DBGF("[WiFi] Connected: %s  IP: %s\n",
    WiFi.SSID().c_str(), WiFi.localIP().toString().c_str());

  // LED: solid ON for 3 seconds to confirm connection, then constant ON
  digitalWrite(PIN_LED_STATUS, HIGH);
  ledState = true;
  delay(LED_CONNECTED_PAUSE_MS);
  ledSetMode(LED_IDLE);

  // ── Enable buzzer now that boot noise is past ──────────────────────────────
  setBuzzerReady(true);
  playReady();

  DBGLN("[ChickenFlow] Ready.");
}

// ─────────────────────────────────────────────────────────────────────────────
// Main loop
// ─────────────────────────────────────────────────────────────────────────────
void loop() {
  unsigned long now = millis();

  // Status LED — runs every iteration for smooth blink/flicker
  ledTick();

  // Reconnect WiFi if dropped
  if (WiFi.status() != WL_CONNECTED) {
    if (ledMode != LED_CONNECTING) ledSetMode(LED_CONNECTING);
    DBGLN("[WiFi] Reconnecting...");
    WiFi.reconnect();
    delay(3000);
    return;
  }

  // Dual-IR tunnel counter — direction from event order.
  tickTunnelCounter();

  // Tick the non-blocking door motor state machine
  tickDoorMotor();

  // Poll backend for commands
  if (now - lastCommandPollMs >= COMMAND_POLL_MS) {
    lastCommandPollMs = now;
    pollCommand();
  }

  musicTick();

  // Post sensor reading
  if (now - lastSensorPostMs >= SENSOR_POST_MS) {
    lastSensorPostMs = now;
    postSensorReading();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Command poll — GET /api/esp32/command
// ─────────────────────────────────────────────────────────────────────────────
void pollCommand() {
  ledFlicker();
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
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Door movement — non-blocking state machine
// ─────────────────────────────────────────────────────────────────────────────

// Kick off a door move. Actual work happens in tickDoorMotor() each loop().
void startDoorMove(const char* direction) {
  motorIsOpening = (strcmp(direction, "OPEN") == 0);
  motorPrevStr = doorStateStr(doorState);
  doorState = motorIsOpening ? DOOR_OPENING : DOOR_CLOSING;
  obstructionRetries = 0;
  motorPhaseStartMs = millis();
  motorPhase = MOTOR_MOVING;

  DBGF("[Door] Moving %s\n", direction);
  if (motorIsOpening) motorOpen();
  else                motorClose();
}

// Called every loop() iteration. Returns immediately if MOTOR_IDLE.
void tickDoorMotor() {
  if (motorPhase == MOTOR_IDLE) return;

  unsigned long now     = millis();
  unsigned long elapsed = now - motorPhaseStartMs;

  switch (motorPhase) {

    // ── MOVING ──────────────────────────────────────────────────────────────
    case MOTOR_MOVING: {
      if (motorIsOpening) {
        // Success when top limit switch triggers (GPIO 3 pulled LOW)
        if (digitalRead(PIN_LIMIT_TOP) == LOW) {
          motorStop();
          reportDoorEvent(motorPrevStr.c_str(), "OPEN");
          doorState  = DOOR_OPEN;
          motorPhase = MOTOR_IDLE;
          playDoorOpen();
          DBGLN("[Door] Reached OPEN (top limit)");
          return;
        }
        // Opening timeout → limit switch never triggered → ERROR
        if (elapsed >= DOOR_TRAVEL_MS_DEFAULT) {
          motorStop();
          doorState  = DOOR_ERROR;
          reportDoorEvent(motorPrevStr.c_str(), "ERROR");
          motorPhase = MOTOR_IDLE;
          playError();
          blinkLed(5, 300);
          DBGLN("[Door] TIMEOUT opening — limit switch not reached");
        }

      } else {
        // CLOSING: timed close — motor runs for the full travel duration.
        // TODO: INA219 stall current detection will replace timed close
        //       once the I2C driver is integrated (see config.h INA219 section).
        if (elapsed >= DOOR_TRAVEL_MS_DEFAULT) {
          motorStop();
          reportDoorEvent(motorPrevStr.c_str(), "CLOSED");
          doorState  = DOOR_CLOSED;
          motorPhase = MOTOR_IDLE;
          playDoorClose();
          DBGLN("[Door] CLOSED (timed)");
          return;
        }
      }
      break;
    }

    // ── REOPEN: briefly opening to clear obstruction (3 s) ────────────────
    case MOTOR_REOPEN:
      if (elapsed >= 3000) {
        motorStop();
        motorPhaseStartMs = now;
        motorPhase = MOTOR_PAUSE;
        DBGLN("[Door] Waiting 30 s for obstruction to clear");
      }
      break;

    // ── PAUSE: waiting 30 s for obstruction to clear ──────────────────────
    case MOTOR_PAUSE:
      if (elapsed >= OBSTRUCTION_WAIT_MS) {
        motorPhaseStartMs = now;
        motorPhase = MOTOR_MOVING;
        motorClose();
        DBGLN("[Door] Retrying close");
      }
      break;

    default:
      motorPhase = MOTOR_IDLE;
      break;
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
// Dual-IR tunnel direction counter
// ─────────────────────────────────────────────────────────────────────────────
void tickTunnelCounter() {
  unsigned long now = millis();
  bool aNow = digitalRead(PIN_IR_SENSOR_A);
  bool bNow = digitalRead(PIN_IR_SENSOR_B);

  bool aBroken = (aNow == LOW && irAPrev == HIGH && (now - irALastEdgeMs > IR_DEBOUNCE_MS));
  bool bBroken = (bNow == LOW && irBPrev == HIGH && (now - irBLastEdgeMs > IR_DEBOUNCE_MS));

  if (aBroken) irALastEdgeMs = now;
  if (bBroken) irBLastEdgeMs = now;
  irAPrev = aNow;
  irBPrev = bNow;

  // Timeout: discard a half-completed crossing
  if (tunnelPhase != TUNNEL_IDLE && (now - tunnelPhaseMs > IR_TUNNEL_TIMEOUT_MS)) {
    DBGLN("[Tunnel] Timeout — partial crossing discarded");
    tunnelPhase = TUNNEL_IDLE;
  }

  switch (tunnelPhase) {
    case TUNNEL_IDLE:
      if (aBroken) {
        tunnelPhase = TUNNEL_A_FIRST;
        tunnelPhaseMs = now;
      } else if (bBroken) {
        tunnelPhase = TUNNEL_B_FIRST;
        tunnelPhaseMs = now;
      }
      break;

    case TUNNEL_A_FIRST:
      if (bBroken) {
        // A→B = OUT (coop → yard)
        chickensInside = max(0, chickensInside - 1);
        DBGF("[Tunnel] A→B  OUT  inside=%d\n", chickensInside);
        tunnelPhase = TUNNEL_IDLE;
      }
      break;

    case TUNNEL_B_FIRST:
      if (aBroken) {
        // B→A = IN (yard → coop)
        chickensInside++;
        DBGF("[Tunnel] B→A  IN  inside=%d\n", chickensInside);
        tunnelPhase = TUNNEL_IDLE;
      }
      break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Obstruction AI gate — POST /api/esp32/obstruction-check
// Returns true if backend is ≥80% confident something is under the door.
// On network failure, returns false (safe retry) — local stop already happened.
// ─────────────────────────────────────────────────────────────────────────────
bool queryObstructionAbort() {
  ledFlicker();
  HTTPClient http;
  http.begin(API_OBSTRUCTION_CHECK);
  http.setTimeout(OBSTRUCTION_CHECK_TIMEOUT_MS);
  http.addHeader("Content-Type", "application/json");

  JsonDocument req;
  req["doorState"] = doorStateStr(doorState);
  String body;
  serializeJson(req, body);

  int code = http.POST(body);
  if (code != 200) {
    DBGF("[ObstructionCheck] HTTP %d — defaulting to retry\n", code);
    http.end();
    return false;
  }

  JsonDocument resp;
  DeserializationError err = deserializeJson(resp, http.getString());
  http.end();
  if (err) {
    DBGF("[ObstructionCheck] JSON err: %s — defaulting to retry\n", err.c_str());
    return false;
  }

  bool  abort      = resp["abort"]      | false;
  float confidence = resp["confidence"] | 0.0f;
  DBGF("[ObstructionCheck] abort=%d confidence=%.2f\n", abort, confidence);
  return abort;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/esp32/sensor
// ─────────────────────────────────────────────────────────────────────────────
void postSensorReading() {
  bool irA = (digitalRead(PIN_IR_SENSOR_A) == LOW);
  bool irB = (digitalRead(PIN_IR_SENSOR_B) == LOW);

  JsonDocument doc;
  doc["irTriggered"]    = irA || irB;
  doc["irATriggered"]   = irA;
  doc["irBTriggered"]   = irB;
  doc["chickensInside"] = chickensInside;
  doc["totalChickens"]  = 0;  // Backend fills from settings
  doc["doorState"]      = doorStateStr(doorState);

  String body;
  serializeJson(doc, body);

  ledFlicker();
  HTTPClient http;
  http.begin(API_SENSOR);
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.addHeader("Content-Type", "application/json");

  int code = http.POST(body);
  DBGF("[Sensor] POST %d  inside=%d\n", code, chickensInside);
  http.end();
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/esp32/door-event
// ─────────────────────────────────────────────────────────────────────────────
void reportDoorEvent(const char* fromState, const char* toState) {
  ledFlicker();
  JsonDocument doc;
  doc["fromState"]      = fromState;
  doc["toState"]        = toState;
  doc["chickensInside"] = chickensInside;

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

// Short blocking blink on the status LED (GPIO 15). Used for error codes only.
void blinkLed(int times, int delayMs) {
  for (int i = 0; i < times; i++) {
    setLight(true);
    delay(delayMs);
    setLight(false);
    delay(delayMs);
  }
}

void lightOn() {
  digitalWrite(PIN_LED_STATUS, HIGH);
}

void lightOff() {
  digitalWrite(PIN_LED_STATUS, LOW);
}

void setLight(bool on) {
  digitalWrite(PIN_LED_STATUS, on ? HIGH : LOW);
}

// ── Status LED state machine ─────────────────────────────────────────────
// Phase 1: rapid blink while WiFi is connecting
// Phase 2: solid ON for 3 seconds after WiFi connects
// Phase 3: constant ON, brief OFF flickers on HTTP traffic (HDD style)

void ledSetMode(LedMode mode) {
  ledMode = mode;
  ledPhaseStartMs = millis();
  ledLastToggleMs = millis();

  switch (mode) {
    case LED_CONNECTING:
      ledState = false;
      digitalWrite(PIN_LED_STATUS, LOW);
      break;
    case LED_CONNECTED_PAUSE:
      ledState = true;
      digitalWrite(PIN_LED_STATUS, HIGH);
      break;
    case LED_IDLE:
      ledState = true;
      digitalWrite(PIN_LED_STATUS, HIGH);
      break;
    case LED_TRANSFER:
      // Entered by ledFlicker(), not directly
      break;
  }
}

void ledTick() {
  unsigned long now = millis();

  switch (ledMode) {
    case LED_CONNECTING:
      // Rapid blink: toggle every LED_BLINK_CONNECTING_MS
      if (now - ledLastToggleMs >= LED_BLINK_CONNECTING_MS) {
        ledLastToggleMs = now;
        ledState = !ledState;
        digitalWrite(PIN_LED_STATUS, ledState ? HIGH : LOW);
      }
      break;

    case LED_CONNECTED_PAUSE:
      // Solid ON for LED_CONNECTED_PAUSE_MS, then transition to IDLE
      if (now - ledPhaseStartMs >= LED_CONNECTED_PAUSE_MS) {
        ledSetMode(LED_IDLE);
      }
      break;

    case LED_IDLE:
      // Constant ON — nothing to do
      if (!ledState) {
        ledState = true;
        digitalWrite(PIN_LED_STATUS, HIGH);
      }
      break;

    case LED_TRANSFER:
      // Brief OFF flicker, then back to IDLE
      if (now - ledPhaseStartMs >= LED_TRANSFER_FLICKER_MS) {
        ledTransferFlickers--;
        if (ledTransferFlickers <= 0) {
          ledSetMode(LED_IDLE);
        } else {
          // Another flicker cycle: ON briefly, then OFF again
          ledState = true;
          digitalWrite(PIN_LED_STATUS, HIGH);
          ledPhaseStartMs = now;
          // The next tick will turn it off after the gap
        }
      }
      break;
  }
}

// Called before each HTTP request — triggers a brief OFF flicker (HDD style).
// LED is normally ON; this interrupts it momentarily.
void ledFlicker() {
  if (ledMode == LED_CONNECTING || ledMode == LED_CONNECTED_PAUSE) return;
  ledMode = LED_TRANSFER;
  ledTransferFlickers = 1;
  ledPhaseStartMs = millis();
  ledState = false;
  digitalWrite(PIN_LED_STATUS, LOW);
}

// ── Melodies ─────────────────────────────────────────────────────────────────
// Two ascending notes — system ready / WiFi connected
void playReady() {
  buzzTone(NOTE_C5, 100); delay(40);
  buzzTone(NOTE_E5, 100); delay(40);
  buzzTone(NOTE_G5, 150);
}

// Door open theme — start a 5-minute GoT theme sequence.
void playDoorOpen() {
  startGoTTheme(GOT_THEME_DURATION_MS);
}

// Door close theme — start a 5-minute GoT theme sequence.
void playDoorClose() {
  startGoTTheme(GOT_THEME_DURATION_MS);
}

// Rapid double-beep — obstruction detected
void playObstruction() {
  buzzTone(NOTE_A4, 120); delay(60);
  buzzTone(NOTE_A4, 120);
}

// Descending three-note — error
void playError() {
  buzzTone(NOTE_G4, 150); delay(40);
  buzzTone(NOTE_E4, 150); delay(40);
  buzzTone(NOTE_C4, 300);
}
