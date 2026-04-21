#include <Arduino.h>
/*
 * ChickenFlow ESP32-S2 Mini Firmware
 * ─────────────────────────────────────────────────────────────────────────────
 * Board   : ESP32-S2 Mini (LOLIN S2 Mini / similar)
 * Core    : esp32 by Espressif (Arduino core 2.0.17)
 *
 * Transport: MQTT to mosquitto on k3s. Non-blocking publish queue — events are
 *            enqueued and drained from loop() so broker unreachability never
 *            stalls the motor state machine.
 *
 * Motor   : BTS7960 H-bridge driven from Xbox 360 150W PSU's 12V rail.
 *           PIN_PSU_ON wakes the PSU via a PC817 optocoupler (active HIGH —
 *           Xbox 360 supplies are active-high, opposite of ATX).
 *           Active-brake phase shorts motor coils before releasing EN to
 *           prevent gravity-drop from unspooling the cable.
 *
 * Safety  : Dual limit switches + INA219 stall current (with inrush mask) +
 *           dual IR tunnel (obstruction during close → reverse/pause/retry).
 *
 * Autonomy: DS3231 + Dusk2Dawn compute local sunrise/sunset. When MQTT has
 *           been down past MQTT_AUTONOMY_GRACE_MS the firmware schedules its
 *           own open/close. Broker is override-only.
 */

#include <Wire.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Adafruit_INA219.h>
#include <RTClib.h>
#include <Dusk2Dawn.h>
#include <Preferences.h>
#include "config.h"
#include "music.h"

// ─────────────────────────────────────────────────────────────────────────────
// Door state machine
// ─────────────────────────────────────────────────────────────────────────────
enum DoorState { DOOR_OPEN, DOOR_CLOSED, DOOR_OPENING, DOOR_CLOSING, DOOR_ERROR };

// Motor sub-phases for the non-blocking movement state machine.
//   IDLE         : standby, PSU asleep
//   WAKING_PSU   : PIN_PSU_ON HIGH, waiting for 12V rail to come up
//   MOVING       : PWM ramping / running, watching limits + stall + IR + timeout
//   ACTIVE_BRAKE : EN HIGH, both PWM at 0 — shorts motor coils to stop mass
//   REOPEN       : IR-tripped during close — reverse briefly to clear tunnel
//   PAUSE        : wait for chicken to clear before retrying close
//   ERROR        : terminal — requires MQTT ACK_ERROR to reset
enum Phase { PHASE_IDLE, PHASE_WAKING_PSU, PHASE_MOVING, PHASE_ACTIVE_BRAKE,
             PHASE_REOPEN, PHASE_PAUSE, PHASE_ERROR };

// Lamp modes — 12V warning lamp (XY-MOS low-side). The lamp pulls 12V from the
// Xbox PSU, so any non-OFF mode forces PSU wake (see updateLamp).
//   OFF              : dark; PSU free to sleep
//   ON               : steady (motor active or waking)
//   ERROR_BLINK      : 500/500 ms square — terminal fault
//   SERVICE_ERRATIC  : double-pulse every 2 s — service-mode attention
enum LampMode { LAMP_OFF, LAMP_ON, LAMP_ERROR_BLINK, LAMP_SERVICE_ERRATIC };

constexpr unsigned long LAMP_ERROR_HALF_PERIOD_MS = 500;
constexpr unsigned long LAMP_SERVICE_PULSE_MS     = 100;
constexpr unsigned long LAMP_SERVICE_GAP_MS       = 150;
constexpr unsigned long LAMP_SERVICE_CYCLE_MS     = 2000;

constexpr uint32_t      BUZZER_ERROR_FREQ           = 2500;
constexpr unsigned long BUZZER_ERROR_HALF_PERIOD_MS = 500;
constexpr uint32_t      BUZZER_REMINDER_FREQ        = 1800;
constexpr unsigned long BUZZER_REMINDER_BEEP_MS     = 80;
constexpr unsigned long BUZZER_REMINDER_GAP_MS      = 80;

DoorState     doorState          = DOOR_CLOSED;
DoorState     prevReportedState  = DOOR_CLOSED;
Phase         motorPhase         = PHASE_IDLE;
bool          motorIsOpening     = false;
uint8_t       obstructionRetries = 0;
String        motorPrevStr;            // door state string before movement started
unsigned long motorPhaseStartMs  = 0;
const char*   pendingStopReason  = nullptr;  // "limit" | "stall" | "timeout" | "obstruction" | "command"

// ─────────────────────────────────────────────────────────────────────────────
// MQTT client + non-blocking publish queue
// ─────────────────────────────────────────────────────────────────────────────
WiFiClient    netClient;
PubSubClient  mqttClient(netClient);
unsigned long lastMqttReconnectMs  = 0;
unsigned long lastMqttConnectedMs  = 0;
bool          wasMqttConnected     = false;

struct MqttMsg {
  char     topic[40];
  char     payload[MQTT_QUEUE_PAYLOAD_BYTES];
  uint16_t len;
  bool     retain;
};
MqttMsg mqttQueue[MQTT_QUEUE_SIZE];
uint8_t mqttQHead  = 0;
uint8_t mqttQTail  = 0;
uint8_t mqttQCount = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Peripherals (I²C)
// ─────────────────────────────────────────────────────────────────────────────
Adafruit_INA219 ina219(I2C_ADDR_INA219);
RTC_DS3231      rtc;
bool            ina219Ok = false;
bool            rtcOk    = false;
int             lastStallMa = 0;
float           lastBusV    = 0.0f;

// ─────────────────────────────────────────────────────────────────────────────
// Runtime config (seeded from defaults, overridden by retained coop/config)
// ─────────────────────────────────────────────────────────────────────────────
Preferences   prefs;
float         runtimeLat        = SOLAR_LAT_DEFAULT;
float         runtimeLon        = SOLAR_LON_DEFAULT;
int           runtimeTzMin      = SOLAR_TZ_OFFSET_MIN;
int           runtimeNudgeMin   = SOLAR_NUDGE_MIN;
uint32_t      runtimeTravelMs   = DOOR_TRAVEL_MS_DEFAULT;
Dusk2Dawn*    solarCalc         = nullptr;
unsigned long lastAutonomyCheckMs = 0;
unsigned long lastAutonomyActionMs = 0;
int           lastAutonomyDay   = -1;  // day-of-year of last scheduled action

// ─────────────────────────────────────────────────────────────────────────────
// Chicken counter — dual-IR tunnel state machine
// Beam A = coop-side  |  Beam B = yard-side
// A→B = OUT,  B→A = IN
// ─────────────────────────────────────────────────────────────────────────────
enum TunnelPhase { TUNNEL_IDLE, TUNNEL_A_FIRST, TUNNEL_B_FIRST };

volatile int  chickensInside   = 0;
TunnelPhase   tunnelPhase      = TUNNEL_IDLE;
unsigned long tunnelPhaseMs    = 0;
bool          irAPrev          = HIGH;
bool          irBPrev          = HIGH;
unsigned long irALastEdgeMs    = 0;
unsigned long irBLastEdgeMs    = 0;

// ─────────────────────────────────────────────────────────────────────────────
// LDR optical safety gate — analog read on PIN_LDR with integer EMA
// ─────────────────────────────────────────────────────────────────────────────
int32_t       ldrSmoothedX100  = -1;
unsigned long ldrLastSampleMs  = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Timers
// ─────────────────────────────────────────────────────────────────────────────
unsigned long lastTelemetryMs = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Manual button + service mode (unchanged from HTTP-era — only the sink swaps)
// ─────────────────────────────────────────────────────────────────────────────
bool          buttonStablePressed = false;
bool          buttonRawLast       = HIGH;
unsigned long buttonLastChangeMs  = 0;
unsigned long buttonPressStartMs  = 0;
bool          buttonChirped5s     = false;
bool          buttonChirped10s    = false;

// Local mirror of backend serviceMode — synced from retained coop/config.
bool          backendServiceMode     = false;

// Lamp state machine (driven by updateLamp, non-blocking).
LampMode      currentLampMode        = LAMP_OFF;
unsigned long lampPatternStartMs     = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Status LED
// ─────────────────────────────────────────────────────────────────────────────
enum LedMode { LED_CONNECTING, LED_CONNECTED_PAUSE, LED_IDLE, LED_TRANSFER };
LedMode       ledMode         = LED_CONNECTING;
unsigned long ledPhaseStartMs = 0;
unsigned long ledLastToggleMs = 0;
bool          ledState        = false;
int           ledTransferFlickers = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Prototypes
// ─────────────────────────────────────────────────────────────────────────────
void     tickTunnelCounter();
void     tickLdr();
void     tickDoorMotor();
void     tickButton();
void     updateBuzzer();
void     tickMqtt();
void     tickAutonomy();

void     startDoorMove(const char* direction);
void     enterActiveBrake(const char* reason);

void     motorDrive(bool opening, uint8_t duty);
void     motorCoast();
void     motorActiveBrake();

void     mqttConnect();
void     mqttCallback(char* topic, uint8_t* payload, unsigned int len);
bool     mqttEnqueue(const char* topic, const char* payload, bool retain = false);
void     mqttDrain();

void     publishTelemetry();
void     publishTransit(const char* direction);
void     publishDoorTransition(const char* from, const char* to, const char* reason);
void     publishError(const char* reason);
void     publishButton(const char* kind);

void     applyConfigJson(JsonDocument& doc);
void     rebuildSolarCalc();
bool     bulgariaDst(const DateTime& t);

String   doorStateStr(DoorState s);
String   phaseStr(Phase p);
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
void     syncServiceMode(bool on);
void     updateLamp();

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────
void setup() {
  DBG_BEGIN(115200);
  DBGLN("\n[ChickenFlow] Booting...");

  // ── GPIO setup ─────────────────────────────────────────────────────────────
  // BTS7960 enable and PSU wake: drive LOW before anything else so a brownout
  // reset can never leave the 12V rail hot.
  pinMode(PIN_BTS_EN,   OUTPUT); digitalWrite(PIN_BTS_EN,   LOW);
  pinMode(PIN_PSU_ON,   OUTPUT); digitalWrite(PIN_PSU_ON,   LOW);

  // BTS7960 PWM channels — one per direction.
  ledcSetup(LEDC_MOTOR_RPWM_CHANNEL, LEDC_MOTOR_FREQ, LEDC_MOTOR_RESOLUTION);
  ledcSetup(LEDC_MOTOR_LPWM_CHANNEL, LEDC_MOTOR_FREQ, LEDC_MOTOR_RESOLUTION);
  ledcAttachPin(PIN_BTS_RPWM, LEDC_MOTOR_RPWM_CHANNEL);
  ledcAttachPin(PIN_BTS_LPWM, LEDC_MOTOR_LPWM_CHANNEL);
  ledcWrite(LEDC_MOTOR_RPWM_CHANNEL, 0);
  ledcWrite(LEDC_MOTOR_LPWM_CHANNEL, 0);

  // IR tunnel beams: LOW = beam broken.
  pinMode(PIN_IR_SENSOR_A, INPUT);
  pinMode(PIN_IR_SENSOR_B, INPUT);

  // Limit switches: top has an external 10k pull-up (NO config, LOW = triggered).
  pinMode(PIN_LIMIT_TOP,    INPUT);
  pinMode(PIN_LIMIT_BOTTOM, INPUT_PULLUP);

  // Status LED + service-mode indicator.
  pinMode(PIN_LED_STATUS, OUTPUT); digitalWrite(PIN_LED_STATUS, LOW);
  pinMode(PIN_LAMP, OUTPUT); digitalWrite(PIN_LAMP, LOW);

  // Manual override button.
  pinMode(PIN_MANUAL_BUTTON, INPUT_PULLUP);

  // Passive buzzer — stays silent until WiFi up.
  buzzerInit();

  // ── I²C peripherals ────────────────────────────────────────────────────────
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);

  ina219Ok = ina219.begin();
  if (ina219Ok) {
    ina219.setCalibration_32V_2A();
    DBGLN("[INA219] OK");
  } else {
    // Stall detection is mandatory — refuse to move the door without it.
    DBGLN("[INA219] FAILED to init — motor operations disabled");
    motorPhase = PHASE_ERROR;
    pendingStopReason = "no_ina219";
  }

  rtcOk = rtc.begin();
  if (!rtcOk) {
    DBGLN("[RTC] DS3231 not found — autonomy disabled (broker only)");
  } else if (rtc.lostPower()) {
    DBGLN("[RTC] Lost power — set time via coop/config");
  } else {
    DateTime n = rtc.now();
    DBGF("[RTC] %04d-%02d-%02d %02d:%02d:%02d\n",
         n.year(), n.month(), n.day(), n.hour(), n.minute(), n.second());
  }

  // Load persisted config overrides (survive power cycle).
  prefs.begin("coop", false);
  runtimeLat      = prefs.getFloat("lat",       SOLAR_LAT_DEFAULT);
  runtimeLon      = prefs.getFloat("lon",       SOLAR_LON_DEFAULT);
  runtimeTzMin    = prefs.getInt  ("tzMin",     SOLAR_TZ_OFFSET_MIN);
  runtimeNudgeMin = prefs.getInt  ("nudgeMin",  SOLAR_NUDGE_MIN);
  runtimeTravelMs = prefs.getUInt ("travelMs",  DOOR_TRAVEL_MS_DEFAULT);
  rebuildSolarCalc();

  // ── Determine door position from top limit switch ──────────────────────────
  if (digitalRead(PIN_LIMIT_TOP) == LOW) {
    doorState = DOOR_OPEN;
    DBGLN("[Door] Boot state: OPEN (top limit active)");
  } else {
    doorState = DOOR_CLOSED;
    DBGLN("[Door] Boot state: CLOSED (assumed — top limit not active)");
  }
  prevReportedState = doorState;

  // ── WiFi via WiFiManager ───────────────────────────────────────────────────
  ledSetMode(LED_CONNECTING);

  WiFiManager wm;
  wm.setConfigPortalTimeout(WIFI_AP_TIMEOUT_S);
  wm.setWebServerCallback([&]() {
    unsigned long now = millis();
    if (now - ledLastToggleMs >= LED_BLINK_CONNECTING_MS) {
      ledLastToggleMs = now;
      ledState = !ledState;
      digitalWrite(PIN_LED_STATUS, ledState ? HIGH : LOW);
    }
  });

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

  digitalWrite(PIN_LED_STATUS, HIGH);
  ledState = true;
  delay(LED_CONNECTED_PAUSE_MS);
  ledSetMode(LED_IDLE);

  // ── MQTT ──────────────────────────────────────────────────────────────────
  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setKeepAlive(MQTT_KEEPALIVE_S);
  mqttClient.setBufferSize(MQTT_BUFFER_SIZE);
  mqttClient.setCallback(mqttCallback);
  lastMqttConnectedMs = millis();  // treat boot as "just connected" so autonomy waits out the grace window

  setBuzzerReady(true);
  playReady();

  DBGLN("[ChickenFlow] Ready.");
}

// ─────────────────────────────────────────────────────────────────────────────
// Main loop
// ─────────────────────────────────────────────────────────────────────────────
void loop() {
  unsigned long now = millis();

  ledTick();

  if (WiFi.status() != WL_CONNECTED) {
    if (ledMode != LED_CONNECTING) ledSetMode(LED_CONNECTING);
    DBGLN("[WiFi] Reconnecting...");
    WiFi.reconnect();
    delay(3000);
    return;
  }

  tickMqtt();
  tickTunnelCounter();
  tickLdr();
  tickDoorMotor();
  updateLamp();
  tickButton();
  tickAutonomy();
  musicTick();
  updateBuzzer();  // runs last so error siren overrides any melody writes

  if (now - lastTelemetryMs >= MQTT_TELEMETRY_INTERVAL_MS) {
    lastTelemetryMs = now;
    publishTelemetry();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MQTT — connect, pump, queue drain
// ─────────────────────────────────────────────────────────────────────────────
void tickMqtt() {
  unsigned long now = millis();

  if (mqttClient.connected()) {
    mqttClient.loop();
    if (!wasMqttConnected) {
      wasMqttConnected = true;
      DBGLN("[MQTT] connected");
    }
    lastMqttConnectedMs = now;
    mqttDrain();
    return;
  }

  wasMqttConnected = false;
  if (now - lastMqttReconnectMs < MQTT_RECONNECT_MS) return;
  lastMqttReconnectMs = now;
  mqttConnect();
}

void mqttConnect() {
  ledFlicker();
  DBGLN("[MQTT] connecting...");
  if (mqttClient.connect(MQTT_CLIENT_ID)) {
    mqttClient.subscribe(MQTT_T_DOOR_CMD);
    mqttClient.subscribe(MQTT_T_CONFIG);
    DBGLN("[MQTT] subscribed");
    // Publish a current-state snapshot so the backend doesn't wait for the next cycle.
    publishTelemetry();
  } else {
    DBGF("[MQTT] connect failed rc=%d\n", mqttClient.state());
  }
}

void mqttCallback(char* topic, uint8_t* payload, unsigned int len) {
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, payload, len);
  if (err) {
    DBGF("[MQTT] %s parse error: %s\n", topic, err.c_str());
    return;
  }

  if (strcmp(topic, MQTT_T_DOOR_CMD) == 0) {
    const char* action = doc["action"] | "NONE";
    DBGF("[MQTT] cmd action=%s (phase=%s door=%s)\n",
         action, phaseStr(motorPhase).c_str(), doorStateStr(doorState).c_str());

    if (strcmp(action, "ACK_ERROR") == 0 && motorPhase == PHASE_ERROR) {
      motorPhase = PHASE_IDLE;
      pendingStopReason = nullptr;
      DBGLN("[MQTT] error acknowledged — IDLE");
      return;
    }
    if (motorPhase != PHASE_IDLE) return;  // ignore until current move finishes
    if (backendServiceMode) {
      DBGLN("[MQTT] cmd ignored — serviceMode ON (motor disabled)");
      return;
    }
    if (strcmp(action, "OPEN") == 0 && doorState != DOOR_OPEN) {
      startDoorMove("OPEN");
    } else if (strcmp(action, "CLOSE") == 0 && doorState != DOOR_CLOSED) {
      startDoorMove("CLOSE");
    }
    return;
  }

  if (strcmp(topic, MQTT_T_CONFIG) == 0) {
    applyConfigJson(doc);
    return;
  }
}

bool mqttEnqueue(const char* topic, const char* payload, bool retain) {
  if (mqttQCount >= MQTT_QUEUE_SIZE) {
    mqttQHead = (mqttQHead + 1) % MQTT_QUEUE_SIZE;
    mqttQCount--;
    DBGLN("[MQTT] queue overflow — dropped oldest");
  }
  MqttMsg& m = mqttQueue[mqttQTail];
  strncpy(m.topic, topic, sizeof(m.topic) - 1);
  m.topic[sizeof(m.topic) - 1] = 0;
  size_t n = strlen(payload);
  if (n >= sizeof(m.payload)) n = sizeof(m.payload) - 1;
  memcpy(m.payload, payload, n);
  m.payload[n] = 0;
  m.len = n;
  m.retain = retain;
  mqttQTail = (mqttQTail + 1) % MQTT_QUEUE_SIZE;
  mqttQCount++;
  return true;
}

void mqttDrain() {
  while (mqttQCount > 0 && mqttClient.connected()) {
    MqttMsg& m = mqttQueue[mqttQHead];
    ledFlicker();
    bool ok = mqttClient.publish(m.topic, (const uint8_t*)m.payload, m.len, m.retain);
    if (!ok) break;
    mqttQHead = (mqttQHead + 1) % MQTT_QUEUE_SIZE;
    mqttQCount--;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Publishers (non-blocking — all go through the queue)
// ─────────────────────────────────────────────────────────────────────────────
static inline int ldrSmoothedValue() {
  return ldrSmoothedX100 < 0 ? 0 : (int)(ldrSmoothedX100 / 100);
}

void publishTelemetry() {
  bool irA = (digitalRead(PIN_IR_SENSOR_A) == LOW);
  bool irB = (digitalRead(PIN_IR_SENSOR_B) == LOW);

  // Sample INA219 if present — bus voltage on the 12V rail + last-seen current.
  if (ina219Ok) {
    lastBusV = ina219.getBusVoltage_V();
  }

  JsonDocument doc;
  doc["doorState"]      = doorStateStr(doorState);
  doc["phase"]          = phaseStr(motorPhase);
  doc["chickensInside"] = chickensInside;
  doc["ir1"]            = irA;
  doc["ir2"]            = irB;
  doc["lightLevel"]     = ldrSmoothedValue();
  doc["busV"]           = lastBusV;
  doc["motorMa"]        = lastStallMa;
  doc["wifiDbm"]        = WiFi.RSSI();
  doc["uptimeS"]        = (uint32_t)(millis() / 1000);
  if (rtcOk) {
    DateTime n = rtc.now();
    char iso[24];
    snprintf(iso, sizeof(iso), "%04d-%02d-%02dT%02d:%02d:%02d",
             n.year(), n.month(), n.day(), n.hour(), n.minute(), n.second());
    doc["rtc"] = iso;
  }

  char buf[MQTT_QUEUE_PAYLOAD_BYTES];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  if (n == 0) return;
  mqttEnqueue(MQTT_T_TELEMETRY, buf);
}

void publishTransit(const char* direction) {
  JsonDocument doc;
  doc["direction"]      = direction;
  doc["chickensInside"] = chickensInside;
  doc["uptimeS"]        = (uint32_t)(millis() / 1000);
  char buf[160];
  serializeJson(doc, buf, sizeof(buf));
  mqttEnqueue(MQTT_T_COUNT, buf);
}

void publishDoorTransition(const char* from, const char* to, const char* reason) {
  JsonDocument doc;
  doc["type"]   = "transition";
  doc["from"]   = from;
  doc["to"]     = to;
  if (reason) doc["reason"] = reason;
  doc["chickensInside"] = chickensInside;
  char buf[200];
  serializeJson(doc, buf, sizeof(buf));
  mqttEnqueue(MQTT_T_DOOR_STATUS, buf);
}

void publishError(const char* reason) {
  JsonDocument doc;
  doc["type"]      = "error";
  doc["reason"]    = reason;
  doc["doorState"] = doorStateStr(doorState);
  doc["busV"]      = lastBusV;
  doc["motorMa"]   = lastStallMa;
  char buf[200];
  serializeJson(doc, buf, sizeof(buf));
  mqttEnqueue(MQTT_T_DOOR_STATUS, buf);
}

void publishButton(const char* kind) {
  JsonDocument doc;
  doc["type"] = "button";
  doc["kind"] = kind;
  char buf[120];
  serializeJson(doc, buf, sizeof(buf));
  mqttEnqueue(MQTT_T_DOOR_STATUS, buf);
}

// ─────────────────────────────────────────────────────────────────────────────
// Config ingestion — retained coop/config payload seeds runtime + persists.
// Accepts any subset of fields; missing fields leave current values intact.
// ─────────────────────────────────────────────────────────────────────────────
void applyConfigJson(JsonDocument& doc) {
  bool solarChanged = false;

  if (doc["lat"].is<float>()) {
    float v = doc["lat"].as<float>();
    if (fabsf(v - runtimeLat) > 0.0001f) { runtimeLat = v; prefs.putFloat("lat", v); solarChanged = true; }
  }
  if (doc["lon"].is<float>()) {
    float v = doc["lon"].as<float>();
    if (fabsf(v - runtimeLon) > 0.0001f) { runtimeLon = v; prefs.putFloat("lon", v); solarChanged = true; }
  }
  if (doc["tzOffsetMin"].is<int>()) {
    int v = doc["tzOffsetMin"].as<int>();
    if (v != runtimeTzMin) { runtimeTzMin = v; prefs.putInt("tzMin", v); solarChanged = true; }
  }
  if (doc["nudgeMin"].is<int>()) {
    int v = doc["nudgeMin"].as<int>();
    if (v != runtimeNudgeMin) { runtimeNudgeMin = v; prefs.putInt("nudgeMin", v); }
  }
  if (doc["travelMs"].is<uint32_t>()) {
    uint32_t v = doc["travelMs"].as<uint32_t>();
    if (v != runtimeTravelMs) { runtimeTravelMs = v; prefs.putUInt("travelMs", v); }
  }
  if (doc["serviceMode"].is<bool>()) {
    syncServiceMode(doc["serviceMode"].as<bool>());
  }
  if (doc["rtc"].is<const char*>()) {
    // Backend can push an authoritative time (ISO 8601) — handy when DS3231 is fresh.
    const char* s = doc["rtc"];
    int y, mo, d, h, mi, se;
    if (rtcOk && sscanf(s, "%d-%d-%dT%d:%d:%d", &y, &mo, &d, &h, &mi, &se) == 6) {
      rtc.adjust(DateTime(y, mo, d, h, mi, se));
      DBGF("[RTC] adjusted from config: %s\n", s);
    }
  }

  if (solarChanged) rebuildSolarCalc();
  DBGF("[Config] lat=%.4f lon=%.4f tz=%d nudge=%d travel=%u svc=%d\n",
       runtimeLat, runtimeLon, runtimeTzMin, runtimeNudgeMin,
       runtimeTravelMs, backendServiceMode);
}

void rebuildSolarCalc() {
  if (solarCalc) { delete solarCalc; solarCalc = nullptr; }
  // Dusk2Dawn expects offset in hours as a float.
  solarCalc = new Dusk2Dawn(runtimeLat, runtimeLon, runtimeTzMin / 60.0f);
}

// Bulgaria DST: last Sunday March 03:00 → last Sunday October 04:00.
// Cheap per-hour check; Dusk2Dawn's third arg to sunrise()/sunset() toggles the shift.
bool bulgariaDst(const DateTime& t) {
  int m = t.month();
  if (m < 3 || m > 10) return false;
  if (m > 3 && m < 10) return true;
  // March or October — find last Sunday.
  int daysInMonth = (m == 3) ? 31 : 31;
  int lastSunday = daysInMonth;
  for (int d = daysInMonth; d >= 25; d--) {
    DateTime probe(t.year(), m, d, 12, 0, 0);
    if (probe.dayOfTheWeek() == 0) { lastSunday = d; break; }
  }
  if (m == 3) {
    if (t.day() > lastSunday) return true;
    if (t.day() < lastSunday) return false;
    return t.hour() >= 3;
  } else {  // October
    if (t.day() < lastSunday) return true;
    if (t.day() > lastSunday) return false;
    return t.hour() < 4;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Autonomy — DS3231 + Dusk2Dawn schedule when MQTT is out past the grace window
// ─────────────────────────────────────────────────────────────────────────────
void tickAutonomy() {
  if (!rtcOk || !solarCalc) return;
  unsigned long now = millis();
  if (now - lastAutonomyCheckMs < 30000) return;   // every 30s is plenty
  lastAutonomyCheckMs = now;

  // Only take over when MQTT has been down long enough.
  bool mqttConnected = mqttClient.connected();
  if (mqttConnected) return;
  if (now - lastMqttConnectedMs < MQTT_AUTONOMY_GRACE_MS) return;
  if (motorPhase != PHASE_IDLE) return;
  if (backendServiceMode) return;  // don't override human intent

  DateTime t = rtc.now();
  bool dst = bulgariaDst(t);
  int sunriseMin = solarCalc->sunrise(t.year(), t.month(), t.day(), dst);
  int sunsetMin  = solarCalc->sunset (t.year(), t.month(), t.day(), dst);
  int nowMin     = t.hour() * 60 + t.minute();

  int openAt  = sunriseMin + runtimeNudgeMin;
  int closeAt = sunsetMin  + runtimeNudgeMin;

  // Suppress repeat firings within the same day. (year*512 + month*32 + day)
  // is a unique, monotonically-ordered key — cheap and avoids DOY math.
  int doy = t.year() * 512 + t.month() * 32 + t.day();
  bool sameDay = (doy == lastAutonomyDay);

  if (nowMin >= openAt && nowMin < closeAt && doorState != DOOR_OPEN) {
    if (!sameDay || lastAutonomyActionMs == 0) {
      DBGLN("[Autonomy] scheduled OPEN");
      lastAutonomyDay = doy;
      lastAutonomyActionMs = now;
      startDoorMove("OPEN");
    }
  } else if (nowMin >= closeAt && doorState != DOOR_CLOSED) {
    if (!sameDay || lastAutonomyActionMs == 0) {
      DBGLN("[Autonomy] scheduled CLOSE");
      lastAutonomyDay = doy;
      lastAutonomyActionMs = now;
      startDoorMove("CLOSE");
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Door movement — non-blocking state machine
// ─────────────────────────────────────────────────────────────────────────────
void startDoorMove(const char* direction) {
  if (!ina219Ok) {
    DBGLN("[Door] refused — INA219 not available");
    publishError("no_ina219");
    return;
  }
  if (backendServiceMode) {
    DBGLN("[Door] refused — serviceMode ON (motor disabled)");
    return;
  }
  if (motorPhase == PHASE_ERROR) {
    DBGLN("[Door] refused — PHASE_ERROR (ACK_ERROR required)");
    return;
  }
  motorIsOpening   = (strcmp(direction, "OPEN") == 0);
  motorPrevStr     = doorStateStr(doorState);
  doorState        = motorIsOpening ? DOOR_OPENING : DOOR_CLOSING;
  obstructionRetries = 0;
  pendingStopReason  = nullptr;
  motorPhaseStartMs  = millis();
  motorPhase         = PHASE_WAKING_PSU;
  digitalWrite(PIN_PSU_ON, HIGH);
  DBGF("[Door] Wake PSU, then %s\n", direction);
}

void enterActiveBrake(const char* reason) {
  pendingStopReason = reason;
  motorActiveBrake();
  motorPhaseStartMs = millis();
  motorPhase = PHASE_ACTIVE_BRAKE;
}

void tickDoorMotor() {
  if (motorPhase == PHASE_IDLE || motorPhase == PHASE_ERROR) return;

  unsigned long now     = millis();
  unsigned long elapsed = now - motorPhaseStartMs;

  switch (motorPhase) {

    case PHASE_WAKING_PSU: {
      if (elapsed < PSU_WAKE_MS) break;
      // Verify the 12V rail actually came up. If the INA219 reads a dead bus,
      // the optocoupler/PSU failed and we refuse to engage the bridge.
      float v = ina219Ok ? ina219.getBusVoltage_V() : 0.0f;
      lastBusV = v;
      if (v < PSU_WAKE_MIN_V) {
        DBGF("[PSU] wake failed — bus=%.2fV (need>=%.1f)\n", v, PSU_WAKE_MIN_V);
        motorCoast();
        doorState = DOOR_ERROR;
        publishError("psu_wake_failed");
        motorPhase = PHASE_ERROR;  // updateLamp keeps PSU up for ERROR blink
        playError();
        return;
      }
      digitalWrite(PIN_BTS_EN, HIGH);
      motorPhaseStartMs = now;
      motorPhase = PHASE_MOVING;
      DBGF("[PSU] up bus=%.2fV — MOVING %s\n", v, motorIsOpening ? "OPEN" : "CLOSE");
      break;
    }

    case PHASE_MOVING: {
      // 1. Soft-start PWM — linear ramp until full duty, then held flat.
      int duty = map((long)elapsed, 0, MOTOR_RAMP_UP_MS, 0, MOTOR_DUTY_MAX);
      if (duty > MOTOR_DUTY_MAX) duty = MOTOR_DUTY_MAX;
      if (duty < 0)              duty = 0;
      motorDrive(motorIsOpening, (uint8_t)duty);

      // 2. Limit-switch success.
      if (motorIsOpening && digitalRead(PIN_LIMIT_TOP) == LOW) {
        DBGLN("[Door] top limit — braking");
        enterActiveBrake("limit");
        break;
      }
      if (!motorIsOpening && digitalRead(PIN_LIMIT_BOTTOM) == LOW) {
        DBGLN("[Door] bottom limit — braking");
        enterActiveBrake("limit");
        break;
      }

      // 3. IR obstruction during close — never the opening path (opening moves
      //    away from chickens standing under the door).
      if (!motorIsOpening &&
          (digitalRead(PIN_IR_SENSOR_A) == LOW || digitalRead(PIN_IR_SENSOR_B) == LOW)) {
        DBGLN("[Door] IR tripped during close — braking for reopen");
        playObstruction();
        enterActiveBrake("obstruction");
        break;
      }

      // 4. INA219 stall — only after inrush mask has passed.
      if (ina219Ok && elapsed > INA219_INRUSH_MASK_MS) {
        float mA = ina219.getCurrent_mA();
        lastStallMa = (int)mA;
        if (mA > INA219_STALL_THRESHOLD_MA) {
          DBGF("[Door] STALL %dmA — braking\n", (int)mA);
          enterActiveBrake("stall");
          break;
        }
      }

      // 5. Hard travel-time watchdog.
      uint32_t maxTravel = (uint32_t)(runtimeTravelMs * DOOR_TRAVEL_SAFETY_MULT);
      if (elapsed > maxTravel) {
        DBGF("[Door] TIMEOUT after %lums — braking\n", elapsed);
        enterActiveBrake("timeout");
        break;
      }
      break;
    }

    case PHASE_ACTIVE_BRAKE: {
      motorActiveBrake();  // idempotent — keep coils shorted
      if (elapsed < MOTOR_BRAKE_MS) break;

      // Brake window finished — release the bridge and decide what's next.
      motorCoast();
      digitalWrite(PIN_BTS_EN, LOW);

      const char* reason = pendingStopReason ? pendingStopReason : "unknown";

      if (strcmp(reason, "limit") == 0) {
        // Successful move — updateLamp will sleep the PSU on next tick.
        DoorState to = motorIsOpening ? DOOR_OPEN : DOOR_CLOSED;
        publishDoorTransition(motorPrevStr.c_str(), doorStateStr(to).c_str(), "limit");
        doorState = to;
        motorPhase = PHASE_IDLE;
        if (motorIsOpening) playDoorOpen(); else playDoorClose();
        DBGF("[Door] reached %s\n", doorStateStr(to).c_str());
        return;
      }

      if (strcmp(reason, "obstruction") == 0 && obstructionRetries < DOOR_RETRY_MAX) {
        // Reverse briefly to clear the tunnel — keep PSU hot between phases.
        obstructionRetries++;
        digitalWrite(PIN_BTS_EN, HIGH);
        motorPhaseStartMs = now;
        motorPhase = PHASE_REOPEN;
        DBGF("[Door] REOPEN retry %d/%d\n", obstructionRetries, DOOR_RETRY_MAX);
        break;
      }

      // Stall, timeout, or out-of-retries obstruction — terminal error.
      // PSU stays up (updateLamp keeps it alive for ERROR_BLINK lamp pattern).
      doorState = DOOR_ERROR;
      publishError(reason);
      playError();
      blinkLed(5, 300);
      motorPhase = PHASE_ERROR;
      DBGF("[Door] ERROR reason=%s\n", reason);
      return;
    }

    case PHASE_REOPEN: {
      // Brief reverse (toward OPEN) to lift off the obstruction.
      int duty = map((long)elapsed, 0, MOTOR_RAMP_UP_MS, 0, MOTOR_DUTY_MAX);
      if (duty > MOTOR_DUTY_MAX) duty = MOTOR_DUTY_MAX;
      motorDrive(true, (uint8_t)duty);
      if (elapsed >= 1500) {
        motorActiveBrake();
        motorPhaseStartMs = now;
        motorPhase = PHASE_PAUSE;
        DBGLN("[Door] paused — waiting for tunnel to clear");
      }
      break;
    }

    case PHASE_PAUSE: {
      motorCoast();
      digitalWrite(PIN_BTS_EN, LOW);
      // Periodic warning buzz so the bird knows to move.
      if (elapsed >= OBSTRUCTION_WAIT_MS) {
        digitalWrite(PIN_BTS_EN, HIGH);
        motorPhaseStartMs = now;
        motorPhase = PHASE_MOVING;
        DBGLN("[Door] resuming close after pause");
      }
      break;
    }

    default:
      motorPhase = PHASE_IDLE;
      break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BTS7960 low-level drive
// ─────────────────────────────────────────────────────────────────────────────
void motorDrive(bool opening, uint8_t duty) {
  if (opening) {
    ledcWrite(LEDC_MOTOR_LPWM_CHANNEL, 0);
    ledcWrite(LEDC_MOTOR_RPWM_CHANNEL, duty);
  } else {
    ledcWrite(LEDC_MOTOR_RPWM_CHANNEL, 0);
    ledcWrite(LEDC_MOTOR_LPWM_CHANNEL, duty);
  }
}

void motorCoast() {
  ledcWrite(LEDC_MOTOR_RPWM_CHANNEL, 0);
  ledcWrite(LEDC_MOTOR_LPWM_CHANNEL, 0);
}

void motorActiveBrake() {
  // EN stays HIGH (caller's responsibility) — both PWM at 0 shorts the motor
  // terminals through the low-side switches, braking the mass electrically.
  ledcWrite(LEDC_MOTOR_RPWM_CHANNEL, 0);
  ledcWrite(LEDC_MOTOR_LPWM_CHANNEL, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Dual-IR tunnel direction counter (unchanged logic, MQTT sink)
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

  if (tunnelPhase != TUNNEL_IDLE && (now - tunnelPhaseMs > IR_TUNNEL_TIMEOUT_MS)) {
    DBGLN("[Tunnel] Timeout — partial crossing discarded");
    tunnelPhase = TUNNEL_IDLE;
  }

  switch (tunnelPhase) {
    case TUNNEL_IDLE:
      if (aBroken)      { tunnelPhase = TUNNEL_A_FIRST; tunnelPhaseMs = now; }
      else if (bBroken) { tunnelPhase = TUNNEL_B_FIRST; tunnelPhaseMs = now; }
      break;

    case TUNNEL_A_FIRST:
      if (bBroken) {
        chickensInside = max(0, chickensInside - 1);
        DBGF("[Tunnel] A→B  OUT  inside=%d\n", chickensInside);
        publishTransit("OUT");
        tunnelPhase = TUNNEL_IDLE;
      }
      break;

    case TUNNEL_B_FIRST:
      if (aBroken) {
        chickensInside++;
        DBGF("[Tunnel] B→A  IN  inside=%d\n", chickensInside);
        publishTransit("IN");
        tunnelPhase = TUNNEL_IDLE;
      }
      break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LDR EMA sampler — analogRead() on PIN_LDR every LDR_SAMPLE_MS. Integer math
// keeps the S2 (no FPU) happy; fraction preserved via x100 scaling.
// ─────────────────────────────────────────────────────────────────────────────
void tickLdr() {
  unsigned long now = millis();
  if (now - ldrLastSampleMs < LDR_SAMPLE_MS) return;
  ldrLastSampleMs = now;

  int32_t raw = analogRead(PIN_LDR);
  int32_t rawX100 = raw * 100;

  if (ldrSmoothedX100 < 0) {
    ldrSmoothedX100 = rawX100;
  } else {
    ldrSmoothedX100 += ((rawX100 - ldrSmoothedX100) * LDR_EMA_ALPHA_X100) / 100;
  }
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

String phaseStr(Phase p) {
  switch (p) {
    case PHASE_IDLE:         return "IDLE";
    case PHASE_WAKING_PSU:   return "WAKING_PSU";
    case PHASE_MOVING:       return "MOVING";
    case PHASE_ACTIVE_BRAKE: return "ACTIVE_BRAKE";
    case PHASE_REOPEN:       return "REOPEN";
    case PHASE_PAUSE:        return "PAUSE";
    case PHASE_ERROR:        return "ERROR";
    default:                 return "UNKNOWN";
  }
}

void blinkLed(int times, int delayMs) {
  for (int i = 0; i < times; i++) {
    setLight(true);  delay(delayMs);
    setLight(false); delay(delayMs);
  }
}

void lightOn()  { digitalWrite(PIN_LED_STATUS, HIGH); }
void lightOff() { digitalWrite(PIN_LED_STATUS, LOW); }
void setLight(bool on) { digitalWrite(PIN_LED_STATUS, on ? HIGH : LOW); }

// ── Status LED state machine ─────────────────────────────────────────────
void ledSetMode(LedMode mode) {
  ledMode = mode;
  ledPhaseStartMs = millis();
  ledLastToggleMs = millis();

  switch (mode) {
    case LED_CONNECTING:      ledState = false; digitalWrite(PIN_LED_STATUS, LOW);  break;
    case LED_CONNECTED_PAUSE: ledState = true;  digitalWrite(PIN_LED_STATUS, HIGH); break;
    case LED_IDLE:            ledState = true;  digitalWrite(PIN_LED_STATUS, HIGH); break;
    case LED_TRANSFER:        break;  // entered via ledFlicker()
  }
}

void ledTick() {
  unsigned long now = millis();

  switch (ledMode) {
    case LED_CONNECTING:
      if (now - ledLastToggleMs >= LED_BLINK_CONNECTING_MS) {
        ledLastToggleMs = now;
        ledState = !ledState;
        digitalWrite(PIN_LED_STATUS, ledState ? HIGH : LOW);
      }
      break;

    case LED_CONNECTED_PAUSE:
      if (now - ledPhaseStartMs >= LED_CONNECTED_PAUSE_MS) ledSetMode(LED_IDLE);
      break;

    case LED_IDLE:
      if (!ledState) { ledState = true; digitalWrite(PIN_LED_STATUS, HIGH); }
      break;

    case LED_TRANSFER:
      if (now - ledPhaseStartMs >= LED_TRANSFER_FLICKER_MS) {
        ledTransferFlickers--;
        if (ledTransferFlickers <= 0) {
          ledSetMode(LED_IDLE);
        } else {
          ledState = true;
          digitalWrite(PIN_LED_STATUS, HIGH);
          ledPhaseStartMs = now;
        }
      }
      break;
  }
}

void ledFlicker() {
  if (ledMode == LED_CONNECTING || ledMode == LED_CONNECTED_PAUSE) return;
  ledMode = LED_TRANSFER;
  ledTransferFlickers = 1;
  ledPhaseStartMs = millis();
  ledState = false;
  digitalWrite(PIN_LED_STATUS, LOW);
}

// ── Melodies ─────────────────────────────────────────────────────────────────
void playReady() {
  buzzTone(NOTE_C5, 100); delay(40);
  buzzTone(NOTE_E5, 100); delay(40);
  buzzTone(NOTE_G5, 150);
}

void playDoorOpen()    { startGoTTheme(GOT_THEME_DURATION_MS); }
void playDoorClose()   { startGoTTheme(GOT_THEME_DURATION_MS); }

void playObstruction() {
  buzzTone(NOTE_A4, 120); delay(60);
  buzzTone(NOTE_A4, 120);
}

void playError() {
  buzzTone(NOTE_G4, 150); delay(40);
  buzzTone(NOTE_E4, 150); delay(40);
  buzzTone(NOTE_C4, 300);
}

// ─────────────────────────────────────────────────────────────────────────────
// Manual override button — same UX as HTTP era, now publishes to MQTT.
//   press ≥ 10 s → "service"  (backend toggles serviceMode)
//   press ≥  5 s → "override" (backend sets manualOverrideUntil)
//   press <   5 s → ignored
// ─────────────────────────────────────────────────────────────────────────────
void tickButton() {
  unsigned long now = millis();
  bool raw = digitalRead(PIN_MANUAL_BUTTON);

  if (raw != buttonRawLast) {
    buttonRawLast = raw;
    buttonLastChangeMs = now;
  }
  if ((now - buttonLastChangeMs) < BUTTON_DEBOUNCE_MS) return;

  bool pressed = (raw == LOW);

  if (pressed && !buttonStablePressed) {
    buttonStablePressed = true;
    buttonPressStartMs  = now;
    buttonChirped5s     = false;
    buttonChirped10s    = false;
    DBGLN("[Button] Press started");
    return;
  }

  if (pressed && buttonStablePressed) {
    unsigned long held = now - buttonPressStartMs;
    if (!buttonChirped5s && held >= BUTTON_PRESS_OVERRIDE_MS) {
      buttonChirped5s = true;
      playOverrideConfirm();
      DBGLN("[Button] Crossed 5s threshold (override)");
    }
    if (!buttonChirped10s && held >= BUTTON_PRESS_SERVICE_MS) {
      buttonChirped10s = true;
      playServiceConfirm();
      DBGLN("[Button] Crossed 10s threshold (service)");
    }
    return;
  }

  if (!pressed && buttonStablePressed) {
    unsigned long held = now - buttonPressStartMs;
    buttonStablePressed = false;
    DBGF("[Button] Released after %lu ms\n", held);

    if (held >= BUTTON_PRESS_SERVICE_MS) {
      publishButton("service");
    } else if (held >= BUTTON_PRESS_OVERRIDE_MS) {
      publishButton("override");
    }
  }
}

// Called from coop/config. The lamp/buzzer state machines pick up the flag
// directly on their next tick (updateLamp → LAMP_SERVICE_ERRATIC, updateBuzzer
// → double-beep every SERVICE_MODE_REMINDER_MS). See docs/wiring.md §6.
void syncServiceMode(bool on) {
  if (on == backendServiceMode) return;
  backendServiceMode = on;
  DBGF("[ServiceMode] sync → %s\n", on ? "ON" : "OFF");
}

// Centralized power + warning-lamp controller.
//   1. Picks the lamp mode (priority: ERROR > service > motor-active > off).
//   2. Drives PIN_PSU_ON from a single formula: motor busy OR lamp needs light.
//   3. Force-clamps PIN_BTS_EN LOW during PHASE_ERROR / serviceMode so the
//      motor is physically disabled even if a stray command slipped through.
//   4. Paints the lamp pin using a non-blocking millis()-driven pattern.
void updateLamp() {
  unsigned long now = millis();

  LampMode desired;
  if (motorPhase == PHASE_ERROR) {
    desired = LAMP_ERROR_BLINK;
  } else if (backendServiceMode) {
    desired = LAMP_SERVICE_ERRATIC;
  } else if (motorPhase != PHASE_IDLE) {
    desired = LAMP_ON;
  } else {
    desired = LAMP_OFF;
  }
  if (desired != currentLampMode) {
    currentLampMode = desired;
    lampPatternStartMs = now;
  }

  // Single source of truth for the Xbox PSU wake line.
  bool needs12V = (motorPhase != PHASE_IDLE) || (currentLampMode != LAMP_OFF);
  digitalWrite(PIN_PSU_ON, needs12V ? HIGH : LOW);

  // Safety clamp: PSU fan may spin and lamp may blink, but the BTS7960 bridge
  // stays cold in error / service states.
  if (motorPhase == PHASE_ERROR || backendServiceMode) {
    digitalWrite(PIN_BTS_EN, LOW);
  }

  bool on = false;
  switch (currentLampMode) {
    case LAMP_ON:
      on = true;
      break;
    case LAMP_ERROR_BLINK:
      on = ((now / LAMP_ERROR_HALF_PERIOD_MS) & 1UL) == 0UL;
      break;
    case LAMP_SERVICE_ERRATIC: {
      unsigned long t = (now - lampPatternStartMs) % LAMP_SERVICE_CYCLE_MS;
      unsigned long pulse2Start = LAMP_SERVICE_PULSE_MS + LAMP_SERVICE_GAP_MS;
      unsigned long pulse2End   = pulse2Start + LAMP_SERVICE_PULSE_MS;
      on = (t < LAMP_SERVICE_PULSE_MS) || (t >= pulse2Start && t < pulse2End);
      break;
    }
    case LAMP_OFF:
    default:
      on = false;
      break;
  }
  digitalWrite(PIN_LAMP, on ? HIGH : LOW);
}

// Non-blocking buzzer state machine. Called once per loop iteration.
//   Priority 1 — PHASE_ERROR: continuous 500/500 ms siren (overrides melodies).
//   Priority 2 — serviceMode: short double-beep every SERVICE_MODE_REMINDER_MS.
//   Otherwise: silent (musicTick owns the buzzer for melodies).
// No delay() anywhere — all timing is millis()-based.
void updateBuzzer() {
  unsigned long now = millis();

  if (motorPhase == PHASE_ERROR) {
    musicStop();  // halt any GoT theme so the siren isn't stepped on
    bool on = ((now / BUZZER_ERROR_HALF_PERIOD_MS) & 1UL) == 0UL;
    ledcWriteTone(LEDC_BUZZER_CHANNEL, on ? BUZZER_ERROR_FREQ : 0);
    return;
  }

  static enum { BR_WAIT, BR_BEEP1, BR_GAP, BR_BEEP2 } rState = BR_WAIT;
  static unsigned long rPhaseStartMs   = 0;
  static unsigned long rLastReminderMs = 0;
  static bool          rWasServiceMode = false;

  if (!backendServiceMode) {
    if (rWasServiceMode && rState != BR_WAIT) {
      ledcWriteTone(LEDC_BUZZER_CHANNEL, 0);
    }
    rState = BR_WAIT;
    rWasServiceMode = false;
    rLastReminderMs = now;  // first reminder comes SERVICE_MODE_REMINDER_MS after re-entry
    return;
  }

  if (!rWasServiceMode) {
    rWasServiceMode = true;
    rLastReminderMs = now;
    rState = BR_WAIT;
  }

  switch (rState) {
    case BR_WAIT:
      if (now - rLastReminderMs >= SERVICE_MODE_REMINDER_MS) {
        ledcWriteTone(LEDC_BUZZER_CHANNEL, BUZZER_REMINDER_FREQ);
        rPhaseStartMs = now;
        rState = BR_BEEP1;
      }
      break;
    case BR_BEEP1:
      if (now - rPhaseStartMs >= BUZZER_REMINDER_BEEP_MS) {
        ledcWriteTone(LEDC_BUZZER_CHANNEL, 0);
        rPhaseStartMs = now;
        rState = BR_GAP;
      }
      break;
    case BR_GAP:
      if (now - rPhaseStartMs >= BUZZER_REMINDER_GAP_MS) {
        ledcWriteTone(LEDC_BUZZER_CHANNEL, BUZZER_REMINDER_FREQ);
        rPhaseStartMs = now;
        rState = BR_BEEP2;
      }
      break;
    case BR_BEEP2:
      if (now - rPhaseStartMs >= BUZZER_REMINDER_BEEP_MS) {
        ledcWriteTone(LEDC_BUZZER_CHANNEL, 0);
        rLastReminderMs = now;
        rState = BR_WAIT;
      }
      break;
  }
}
