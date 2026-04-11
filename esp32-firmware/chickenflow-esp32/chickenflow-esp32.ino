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
 *   Upload Speed : 115200 (use FTDI adapter — there's no USB on the board)
 *
 * Wiring summary (see config.h for full GPIO table):
 *   HC-SR04 TRIG → GPIO 12   HC-SR04 ECHO → GPIO 13
 *   IR sensor    → GPIO 14   Motor IN1    → GPIO 15   Motor IN2 → GPIO 16
 *   Open limit   → GPIO  3   Close limit  → GPIO  1   LED       → GPIO  2
 *
 * First boot: ESP32 broadcasts "ChickenFlow-Setup" AP.
 *   Connect, open 192.168.4.1, enter your WiFi credentials.
 *   To force re-config: hold GPIO 0 LOW for 3 s on boot.
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
MotorPhase    motorPhase       = MOTOR_IDLE;
bool          motorIsOpening   = false;
String        motorPrevStr;          // door state string before movement started
unsigned long motorPhaseStartMs = 0; // when the current phase began
unsigned long lastObstCheckMs   = 0; // last ultrasonic check during close

// ─────────────────────────────────────────────────────────────────────────────
// Chicken counter (IR pulse counting)
// ─────────────────────────────────────────────────────────────────────────────
volatile int  chickensInside    = 0;
volatile bool irLastState       = HIGH;
unsigned long irLastTriggerMs   = 0;

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

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────
void setup() {
  DBG_BEGIN(115200);
  DBGLN("\n[ChickenFlow] Booting...");

  // GPIO setup
  pinMode(PIN_LED_STATUS,       OUTPUT);
  pinMode(PIN_MOTOR_OPEN,       OUTPUT);
  pinMode(PIN_MOTOR_CLOSE,      OUTPUT);
  pinMode(PIN_ULTRASONIC_TRIG,  OUTPUT);
  pinMode(PIN_ULTRASONIC_ECHO,  INPUT);
  pinMode(PIN_IR_SENSOR,        INPUT_PULLUP);
  pinMode(PIN_LIMIT_OPEN,       INPUT_PULLUP);
  pinMode(PIN_LIMIT_CLOSE,      INPUT_PULLUP);

  motorStop();
  digitalWrite(PIN_LED_STATUS, LOW);

  // Determine door state from limit switches at boot
  if (digitalRead(PIN_LIMIT_OPEN) == LOW) {
    doorState = DOOR_OPEN;
  } else if (digitalRead(PIN_LIMIT_CLOSE) == LOW) {
    doorState = DOOR_CLOSED;
  } else {
    doorState = DOOR_ERROR;  // Neither limit active — unknown position
    blinkLed(5);
  }
  prevReportedState = doorState;
  DBGF("[Door] Boot state: %s\n", doorStateStr(doorState).c_str());

  // Camera
  if (!cameraInit()) {
    DBGLN("[Camera] FAILED — running without camera");
    blinkLed(3, 500);
  }

  // WiFiManager — blocks until connected
  WiFiManager wm;
  wm.setConfigPortalTimeout(180);  // 3-minute AP window before reboot
  blinkLed(2);
  if (!wm.autoConnect(WIFI_AP_NAME, WIFI_AP_PASS)) {
    DBGLN("[WiFi] Config timeout — rebooting");
    ESP.restart();
  }
  DBGF("[WiFi] Connected: %s  IP: %s\n",
    WiFi.SSID().c_str(), WiFi.localIP().toString().c_str());

  blinkLed(3, 80);  // 3 quick blinks = ready
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

  // IR sensor chicken counting (debounced)
  bool irNow = digitalRead(PIN_IR_SENSOR);
  if (irNow == LOW && irLastState == HIGH &&
      (now - irLastTriggerMs > IR_DEBOUNCE_MS)) {
    // Beam broken — count direction depends on door state:
    // door open = chicken going out; door closed = coming in
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
  int limitPin = motorIsOpening ? PIN_LIMIT_OPEN : PIN_LIMIT_CLOSE;

  switch (motorPhase) {

    // ── MOVING: motor is running, check limit switch + obstruction ──────────
    case MOTOR_MOVING: {
      // Limit switch hit → success
      if (digitalRead(limitPin) == LOW) {
        motorStop();
        DoorState target = motorIsOpening ? DOOR_OPEN : DOOR_CLOSED;
        String newStr = doorStateStr(target);
        reportDoorEvent(motorPrevStr.c_str(), newStr.c_str());
        doorState = target;
        obstructionRetries = 0;
        motorPhase = MOTOR_IDLE;
        DBGF("[Door] Reached %s\n", newStr.c_str());
        blinkLed(1, 80);
        return;
      }

      // Travel timeout → ERROR
      if (elapsed >= DOOR_TRAVEL_MS) {
        motorStop();
        doorState = DOOR_ERROR;
        reportDoorEvent(motorPrevStr.c_str(), "ERROR");
        motorPhase = MOTOR_IDLE;
        blinkLed(5, 300);
        DBGLN("[Door] TIMEOUT — limit switch not reached");
        return;
      }

      // Obstruction check during closing (every 50ms)
      if (!motorIsOpening && (now - lastObstCheckMs >= 50)) {
        lastObstCheckMs = now;
        float dist = measureDistanceCm();
        if (dist > 0 && dist < OBSTRUCTION_CM) {
          motorStop();
          DBGF("[Door] Obstruction at %.1f cm\n", dist);
          obstructionRetries++;

          if (obstructionRetries >= DOOR_RETRY_MAX) {
            doorState = DOOR_ERROR;
            reportDoorEvent(motorPrevStr.c_str(), "ERROR");
            motorPhase = MOTOR_IDLE;
            blinkLed(6, 200);
            DBGLN("[Door] ERROR — max retries exceeded");
            return;
          }

          // Re-open briefly (3s)
          motorOpen();
          motorPhaseStartMs = now;
          motorPhase = MOTOR_REOPEN;
        }
      }
      break;
    }

    // ── REOPEN: briefly opening to clear obstruction (3s) ───────────────────
    case MOTOR_REOPEN:
      if (elapsed >= 3000) {
        motorStop();
        motorPhaseStartMs = now;
        motorPhase = MOTOR_PAUSE;
        DBGLN("[Door] Waiting 30s for obstruction to clear");
      }
      break;

    // ── PAUSE: waiting for obstruction to clear (30s) ───────────────────────
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

    long duration = pulseIn(PIN_ULTRASONIC_ECHO, HIGH, 30000); // 30ms timeout
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
  doc["distanceCm"]    = dist;
  doc["irTriggered"]   = ir;
  doc["chickensInside"] = chickensInside;
  doc["totalChickens"]  = 0;  // Backend fills from settings — ESP32 doesn't know the real total
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
  http.setTimeout(HTTP_TIMEOUT_MS + 5000);  // Extra time for image upload

  // Build multipart body manually — HTTPClient doesn't have native multipart
  String boundary = "----CFBoundary" + String(millis());
  String contentType = "multipart/form-data; boundary=" + boundary;

  // Build the multipart header for the image part
  String partHeader =
    "--" + boundary + "\r\n"
    "Content-Disposition: form-data; name=\"image\"; filename=\"capture.jpg\"\r\n"
    "Content-Type: image/jpeg\r\n\r\n";
  String partFooter = "\r\n--" + boundary + "--\r\n";

  // Assemble payload: header bytes + JPEG bytes + footer bytes
  size_t bodyLen = partHeader.length() + fb->len + partFooter.length();
  uint8_t* body  = (uint8_t*)malloc(bodyLen);

  if (!body) {
    DBGLN("[Camera] malloc failed — frame too large?");
    esp_camera_fb_return(fb);
    http.end();
    return;
  }

  size_t offset = 0;
  memcpy(body + offset, partHeader.c_str(), partHeader.length());
  offset += partHeader.length();
  memcpy(body + offset, fb->buf, fb->len);
  offset += fb->len;
  memcpy(body + offset, partFooter.c_str(), partFooter.length());

  esp_camera_fb_return(fb);  // Return framebuffer ASAP

  http.addHeader("Content-Type", contentType);
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

void blinkLed(int times, int delayMs) {
  for (int i = 0; i < times; i++) {
    digitalWrite(PIN_LED_STATUS, HIGH);
    delay(delayMs);
    digitalWrite(PIN_LED_STATUS, LOW);
    delay(delayMs);
  }
}
