/*
 * ChickenFlow ESP32-CAM Firmware
 * ─────────────────────────────────────────────────────────────────────────────
 * Board   : AI Thinker ESP32-CAM
 * Core    : esp32 by Espressif >= 2.0.17 (Arduino IDE Board Manager)
 *
 * Required libraries (install via Arduino IDE Library Manager):
 *   - WiFiManager  by tzapu          >= 2.0.17
 *   - ArduinoJson  by Benoit Blanchon >= 7.0.0
 *   (esp_camera and HTTPClient are included in the ESP32 Arduino core)
 *
 * Flash settings:
 *   Board        : AI Thinker ESP32-CAM
 *   Partition    : Huge APP (3MB No OTA / 1MB SPIFFS)
 *   Flash Freq   : 80MHz
 *   Upload Speed : 115200 (use FTDI adapter — no USB on board)
 *
 * Wiring summary (see config.h for full GPIO table and boot constraints):
 *   Motor IN1    → GPIO 12   Motor IN2     → GPIO 13
 *   TRIG         → GPIO 15   ECHO          → GPIO 14
 *   IR sensor    → GPIO  2   Top limit     → GPIO  3  (external 10kΩ pull-up)
 *   Passive buzz → GPIO  1   Flash LED     → GPIO  4
 *
 * ── Boot-sensitive pins ────────────────────────────────────────────────────
 *   GPIO 12 (Motor IN1):  L298N must not drive this HIGH at power-up.
 *   GPIO 15 (TRIG):       HC-SR04 TRIG is an input; won't pull ESP32 at boot.
 *   GPIO  2 (IR sensor):  Use external 10kΩ pull-DOWN. Never INPUT_PULLUP.
 *   GPIO  1 (Buzzer TX):  Boot ROM emits noise on this pin. Add a transistor
 *                         switch or RC filter in hardware. Firmware keeps LEDC
 *                         silent (0 Hz) until speakerReady=true (after WiFi).
 *
 * Door logic:
 *   OPEN  — motor runs until PIN_LIMIT_TOP (GPIO 3) goes LOW, or timeout→ERROR.
 *   CLOSE — motor runs for DOOR_TRAVEL_MS then declares CLOSED (no bottom
 *           limit switch). Ultrasonic checks for obstructions during close.
 *
 * First boot: ESP32 broadcasts "ChickenFlow-Setup" AP.
 *   Connect → 192.168.4.1 → enter your WiFi credentials.
 *   Force re-config: hold GPIO 0 LOW for 3 s on boot.
 */

#include <WiFi.h>
#include <WiFiManager.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include "esp_camera.h"
#include "config.h"
#include "camera_init.h"

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
// Chicken counter (IR pulse counting)
// ─────────────────────────────────────────────────────────────────────────────
volatile int  chickensInside  = 0;
volatile bool irLastState     = HIGH;
unsigned long irLastTriggerMs = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Buzzer gate — stays false until after WiFi connects to suppress boot noise
// ─────────────────────────────────────────────────────────────────────────────
bool buzzerReady = false;

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
void     motorOpen();
void     motorClose();
void     motorStop();
void     startDoorMove(const char* direction);
void     tickDoorMotor();
void     reportDoorEvent(const char* fromState, const char* toState);
void     postSensorReading();
void     postCameraCapture();
void     pollCommand();
String   doorStateStr(DoorState s);
void     blinkLed(int times, int delayMs = 150);
void     tone(uint32_t freqHz, uint32_t durationMs);
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
  // Motor outputs: drive LOW first — GPIO 12 is a strapping pin and the
  // L298N must not pull it HIGH at power-up.
  pinMode(PIN_MOTOR_OPEN,  OUTPUT);  digitalWrite(PIN_MOTOR_OPEN,  LOW);
  pinMode(PIN_MOTOR_CLOSE, OUTPUT);  digitalWrite(PIN_MOTOR_CLOSE, LOW);

  // Ultrasonic TRIG LOW before enabling (GPIO 15 is MTDO strapping pin).
  pinMode(PIN_ULTRASONIC_TRIG, OUTPUT); digitalWrite(PIN_ULTRASONIC_TRIG, LOW);
  pinMode(PIN_ULTRASONIC_ECHO, INPUT);

  // IR sensor: GPIO 2 is a strapping pin — must NOT use INPUT_PULLUP.
  // Requires external 10kΩ pull-DOWN so the pin idles LOW at boot.
  pinMode(PIN_IR_SENSOR, INPUT);

  // Top limit switch: external 10kΩ pull-up to 3.3V (Normally Open config).
  // HIGH = door traveling, LOW = door fully open (limit triggered).
  pinMode(PIN_LIMIT_TOP, INPUT);

  // Flash LED: very bright — keep off until needed.
  pinMode(PIN_LED_STATUS, OUTPUT);
  digitalWrite(PIN_LED_STATUS, LOW);

  // Passive buzzer on GPIO 1 (TX): configure LEDC but output 0 Hz (silent).
  // Boot ROM already sent noise on this pin; stay silent until WiFi connects.
  ledcSetup(LEDC_BUZZER_CHANNEL, LEDC_BUZZER_FREQ_INIT, LEDC_BUZZER_RESOLUTION);
  ledcAttachPin(PIN_BUZZER, LEDC_BUZZER_CHANNEL);
  ledcWriteTone(LEDC_BUZZER_CHANNEL, 0);  // silent

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

  // ── Camera ─────────────────────────────────────────────────────────────────
  if (!cameraInit()) {
    DBGLN("[Camera] FAILED — running without camera");
    blinkLed(3, 500);
  }

  // ── WiFiManager — blocks until connected or AP timeout ─────────────────────
  WiFiManager wm;
  wm.setConfigPortalTimeout(180);  // 3-minute AP window before reboot
  blinkLed(2);
  if (!wm.autoConnect(WIFI_AP_NAME, WIFI_AP_PASS)) {
    DBGLN("[WiFi] Config timeout — rebooting");
    ESP.restart();
  }
  DBGF("[WiFi] Connected: %s  IP: %s\n",
    WiFi.SSID().c_str(), WiFi.localIP().toString().c_str());

  // ── Enable buzzer now that boot noise is past ──────────────────────────────
  buzzerReady = true;
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

  // IR sensor chicken counting (debounced).
  // GPIO 2 idles HIGH via external pull-down + sensor output; LOW = beam break.
  // INPUT_PULLUP must never be used here — GPIO 2 is a strapping pin.
  bool irNow = digitalRead(PIN_IR_SENSOR);
  if (irNow == LOW && irLastState == HIGH &&
      (now - irLastTriggerMs > IR_DEBOUNCE_MS)) {
    // Beam broken — direction depends on door state:
    // door open = chicken going out; otherwise = coming in
    if (doorState == DOOR_OPEN) {
      chickensInside = max(0, chickensInside - 1);
    } else {
      chickensInside++;
    }
    irLastTriggerMs = now;
    DBGF("[IR] Trigger — chickens inside: %d\n", chickensInside);
  }
  irLastState = irNow;

  // Tick the non-blocking door motor state machine
  tickDoorMotor();

  // Poll backend for commands
  if (now - lastCommandPollMs >= COMMAND_POLL_MS) {
    lastCommandPollMs = now;
    pollCommand();
  }

  // Post sensor reading
  if (now - lastSensorPostMs >= SENSOR_POST_MS) {
    lastSensorPostMs = now;
    postSensorReading();
  }

  // Post camera capture
  if (now - lastCapturePostMs >= CAPTURE_POST_MS) {
    lastCapturePostMs = now;
    postCameraCapture();
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
            motorStop();
            DBGF("[Door] Obstruction at %.1f cm\n", dist);
            playObstruction();
            obstructionRetries++;

            if (obstructionRetries >= DOOR_RETRY_MAX) {
              doorState  = DOOR_ERROR;
              reportDoorEvent(motorPrevStr.c_str(), "ERROR");
              motorPhase = MOTOR_IDLE;
              playError();
              blinkLed(6, 200);
              DBGLN("[Door] ERROR — max obstruction retries exceeded");
              return;
            }

            // Re-open briefly (3 s) to clear obstruction, then pause
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
  bool  ir   = (digitalRead(PIN_IR_SENSOR) == LOW);

  JsonDocument doc;
  doc["distanceCm"]     = dist;
  doc["irTriggered"]    = ir;
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
// POST /api/esp32/capture  (multipart/form-data)
// ─────────────────────────────────────────────────────────────────────────────
void postCameraCapture() {
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) {
    DBGLN("[Camera] Capture failed");
    return;
  }

  HTTPClient http;
  http.begin(API_CAPTURE);
  http.setTimeout(HTTP_TIMEOUT_MS + 5000);

  String boundary   = "----CFBoundary" + String(millis());
  String partHeader =
    "--" + boundary + "\r\n"
    "Content-Disposition: form-data; name=\"image\"; filename=\"capture.jpg\"\r\n"
    "Content-Type: image/jpeg\r\n\r\n";
  String partFooter = "\r\n--" + boundary + "--\r\n";

  size_t bodyLen = partHeader.length() + fb->len + partFooter.length();
  uint8_t* body  = (uint8_t*)malloc(bodyLen);

  if (!body) {
    DBGLN("[Camera] malloc failed — frame too large?");
    esp_camera_fb_return(fb);
    http.end();
    return;
  }

  size_t offset = 0;
  memcpy(body + offset, partHeader.c_str(), partHeader.length()); offset += partHeader.length();
  memcpy(body + offset, fb->buf,            fb->len);              offset += fb->len;
  memcpy(body + offset, partFooter.c_str(), partFooter.length());

  esp_camera_fb_return(fb);  // Return framebuffer ASAP

  http.addHeader("Content-Type", "multipart/form-data; boundary=" + boundary);
  int code = http.POST(body, bodyLen);
  free(body);

  DBGF("[Camera] Capture POST %d\n", code);
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
    digitalWrite(PIN_LED_STATUS, HIGH);
    delay(delayMs);
    digitalWrite(PIN_LED_STATUS, LOW);
    delay(delayMs);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Passive buzzer — LEDC square wave on GPIO 1 (TX)
// ─────────────────────────────────────────────────────────────────────────────
// Single blocking tone. Safe in event handlers (durations 80–400 ms).
// Silently skipped until buzzerReady = true (set after WiFi connects).
void tone(uint32_t freqHz, uint32_t durationMs) {
  if (!buzzerReady) return;
  ledcWriteTone(LEDC_BUZZER_CHANNEL, freqHz);
  delay(durationMs);
  ledcWriteTone(LEDC_BUZZER_CHANNEL, 0);
}

// ── Melodies ─────────────────────────────────────────────────────────────────
// Two ascending notes — system ready / WiFi connected
void playReady() {
  tone(NOTE_C5, 100); delay(40);
  tone(NOTE_E5, 100); delay(40);
  tone(NOTE_G5, 150);
}

// Rising arpeggio — door opened
void playDoorOpen() {
  tone(NOTE_C5, 80); delay(30);
  tone(NOTE_G5, 120);
}

// Falling two-note — door closed
void playDoorClose() {
  tone(NOTE_G5, 80); delay(30);
  tone(NOTE_C5, 120);
}

// Rapid double-beep — obstruction detected
void playObstruction() {
  tone(NOTE_A4, 120); delay(60);
  tone(NOTE_A4, 120);
}

// Descending three-note — error
void playError() {
  tone(NOTE_G4, 150); delay(40);
  tone(NOTE_E4, 150); delay(40);
  tone(NOTE_C4, 300);
}
