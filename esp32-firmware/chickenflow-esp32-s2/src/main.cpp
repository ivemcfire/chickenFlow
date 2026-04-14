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
 *   Ultrasonic TRIG → GPIO  4   ECHO      → GPIO  8
 *   IR sensor    → GPIO  9   Top limit     → GPIO 12
 *   Buzzer       → GPIO 14   Status LED   → GPIO 15
 *   Coop light   → GPIO 16
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
unsigned long lastObstCheckMs   = 0;   // last ultrasonic check during close

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
// Prototypes
// ─────────────────────────────────────────────────────────────────────────────
float    measureDistanceCm();
void     tickTunnelCounter();
bool     queryObstructionAbort(float distanceCm);
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

  // Ultrasonic TRIG LOW before enabling.
  pinMode(PIN_ULTRASONIC_TRIG, OUTPUT); digitalWrite(PIN_ULTRASONIC_TRIG, LOW);
  pinMode(PIN_ULTRASONIC_ECHO, INPUT);

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
  // Stored creds are used silently on subsequent boots. If none are saved (or
  // they fail), the board broadcasts WIFI_AP_NAME for WIFI_AP_TIMEOUT_S so the
  // user can enter credentials without re-flashing.
  WiFiManager wm;
  wm.setConfigPortalTimeout(WIFI_AP_TIMEOUT_S);
  blinkLed(2);
  if (!wm.autoConnect(WIFI_AP_NAME, WIFI_AP_PASS)) {
    DBGLN("[WiFi] Config portal timed out — rebooting");
    ESP.restart();
  }

  DBGF("[WiFi] Connected: %s  IP: %s\n",
    WiFi.SSID().c_str(), WiFi.localIP().toString().c_str());

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

  // Reconnect WiFi if dropped
  if (WiFi.status() != WL_CONNECTED) {
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
  lastObstCheckMs = 0;
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
        // CLOSING: no bottom limit switch — timed close.
        // Timer expiry = declare CLOSED (motor has run the full stroke).
        if (elapsed >= DOOR_TRAVEL_MS) {
          motorStop();
          reportDoorEvent(motorPrevStr.c_str(), "CLOSED");
          doorState  = DOOR_CLOSED;
          motorPhase = MOTOR_IDLE;
          playDoorClose();
          DBGLN("[Door] CLOSED (timed)");
          return;
        }
        // Obstruction check every 50 ms during close
        if (now - lastObstCheckMs >= 50) {
          lastObstCheckMs = now;
          float dist = measureDistanceCm();
          if (dist > 0 && dist < OBSTRUCTION_CM) {
            // Local hard stop — always immediate, never waits on the network.
            motorStop();
            DBGF("[Door] Ultrasonic stop at %.1f cm — asking AI gate\n", dist);
            playObstruction();

            // AI confidence gate: only escalate to ERROR if backend is
            // ≥80% sure something is under the door. Otherwise treat as
            // a false positive and resume the normal retry cycle.
            bool aiAbort = queryObstructionAbort(dist);
            if (aiAbort) {
              doorState  = DOOR_ERROR;
              reportDoorEvent(motorPrevStr.c_str(), "ERROR");
              motorPhase = MOTOR_IDLE;
              playError();
              blinkLed(6, 200);
              DBGLN("[Door] ERROR — AI confirmed obstruction");
              return;
            }

            obstructionRetries++;
            if (obstructionRetries >= DOOR_RETRY_MAX) {
              doorState  = DOOR_ERROR;
              reportDoorEvent(motorPrevStr.c_str(), "ERROR");
              motorPhase = MOTOR_IDLE;
              playError();
              blinkLed(6, 200);
              DBGLN("[Door] ERROR — max retries exceeded");
              return;
            }

            // Re-open briefly (3 s) to clear, then pause
            motorOpen();
            motorPhaseStartMs = now;
            motorPhase = MOTOR_REOPEN;
          }
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
      if (elapsed >= 30000) {
        motorPhaseStartMs = now;
        lastObstCheckMs = 0;
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
bool queryObstructionAbort(float distanceCm) {
  HTTPClient http;
  http.begin(API_OBSTRUCTION_CHECK);
  http.setTimeout(OBSTRUCTION_CHECK_TIMEOUT_MS);
  http.addHeader("Content-Type", "application/json");

  JsonDocument req;
  req["distanceCm"] = distanceCm;
  req["doorState"]  = doorStateStr(doorState);
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
// Ultrasonic distance measurement (median of N samples)
// ─────────────────────────────────────────────────────────────────────────────
float measureDistanceCm() {
  float samples[ULTRASONIC_SAMPLES];

  for (int i = 0; i < ULTRASONIC_SAMPLES; i++) {
    digitalWrite(PIN_ULTRASONIC_TRIG, LOW);
    delayMicroseconds(2);
    digitalWrite(PIN_ULTRASONIC_TRIG, HIGH);
    delayMicroseconds(10);
    digitalWrite(PIN_ULTRASONIC_TRIG, LOW);

    long duration = pulseIn(PIN_ULTRASONIC_ECHO, HIGH, 30000); // 30 ms timeout
    samples[i] = (duration == 0) ? 999.0f : (duration * 0.0343f / 2.0f);
    delay(10);
  }

  // Sort for median
  for (int i = 0; i < ULTRASONIC_SAMPLES - 1; i++) {
    for (int j = i + 1; j < ULTRASONIC_SAMPLES; j++) {
      if (samples[j] < samples[i]) {
        float tmp = samples[i]; samples[i] = samples[j]; samples[j] = tmp;
      }
    }
  }
  return samples[ULTRASONIC_SAMPLES / 2];
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/esp32/sensor
// ─────────────────────────────────────────────────────────────────────────────
void postSensorReading() {
  float dist = measureDistanceCm();
  bool  irA  = (digitalRead(PIN_IR_SENSOR_A) == LOW);
  bool  irB  = (digitalRead(PIN_IR_SENSOR_B) == LOW);

  JsonDocument doc;
  doc["distanceCm"]     = dist;
  doc["irTriggered"]    = irA || irB;  // legacy field: either beam counts
  doc["irATriggered"]   = irA;
  doc["irBTriggered"]   = irB;
  doc["chickensInside"] = chickensInside;
  doc["totalChickens"]  = 0;  // Backend fills from settings
  doc["doorState"]      = doorStateStr(doorState);

  String body;
  serializeJson(doc, body);

  HTTPClient http;
  http.begin(API_SENSOR);
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.addHeader("Content-Type", "application/json");

  int code = http.POST(body);
  DBGF("[Sensor] POST %d  dist=%.1fcm  inside=%d\n", code, dist, chickensInside);
  http.end();
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/esp32/door-event
// ─────────────────────────────────────────────────────────────────────────────
void reportDoorEvent(const char* fromState, const char* toState) {
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

// Short blink on the flash LED (GPIO 4). It's very bright — keep blinks short.
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
