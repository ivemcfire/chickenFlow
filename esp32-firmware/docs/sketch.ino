// ChickenFlow — Wokwi simulation sketch
// ---------------------------------------------------------------------------
// Standalone version of the ESP32-S2 Mini firmware for wokwi.com. Exercises
// every GPIO in chickenflow-esp32-s2/src/config.h without the network stack
// (WiFiManager / MQTT / HTTP), since those can't reach anything in the sim.
//
// Pair with diagram.json in this folder.
// ---------------------------------------------------------------------------

#include <Arduino.h>
#include <Wire.h>

// ── Pin map (mirrors src/config.h) ──────────────────────────────────────────
#define PIN_MOTOR_OPEN    5
#define PIN_MOTOR_CLOSE   7
#define PIN_MOTOR_PWM     6

#define PIN_LIMIT_TOP    12
#define PIN_LIMIT_BOTTOM  8

#define PIN_IR_SENSOR_A   9   // yard side
#define PIN_IR_SENSOR_B  10   // coop side

#define PIN_LDR           4

#define PIN_I2C_SDA      33
#define PIN_I2C_SCL      35
#define I2C_ADDR_DS3231  0x68
#define I2C_ADDR_INA219  0x40
#define I2C_ADDR_BME280  0x76

#define PIN_BUZZER       14
#define PIN_LED_STATUS   15
#define PIN_COOP_LIGHT   16
#define PIN_MANUAL_BUTTON 13

// ── LEDC channels ──────────────────────────────────────────────────────────
#define LEDC_BUZZER_CHANNEL    0
#define LEDC_BUZZER_RESOLUTION 8
#define LEDC_BUZZER_FREQ_INIT  2000

#define LEDC_MOTOR_CHANNEL     1
#define LEDC_MOTOR_RESOLUTION  8
#define LEDC_MOTOR_FREQ        20000

#define MOTOR_DUTY_MAX         255
#define MOTOR_RAMP_UP_MS       1000
#define MOTOR_RAMP_DOWN_MS     500

// ── Timings ────────────────────────────────────────────────────────────────
#define LDR_SAMPLE_MS          500
#define IR_DEBOUNCE_MS         150
#define IR_TUNNEL_TIMEOUT_MS   2000
#define BUTTON_DEBOUNCE_MS     50
#define BUTTON_PRESS_OVERRIDE_MS 5000
#define BUTTON_PRESS_SERVICE_MS  10000
#define DOOR_TRAVEL_MS_DEFAULT   15000

// ── State ──────────────────────────────────────────────────────────────────
enum DoorState { DOOR_OPEN, DOOR_CLOSED, DOOR_OPENING, DOOR_CLOSING, DOOR_ERROR };
DoorState doorState = DOOR_CLOSED;

int  chickensInside    = 0;
bool serviceMode       = false;

enum TunnelPhase { TUNNEL_IDLE, TUNNEL_A_FIRST, TUNNEL_B_FIRST };
TunnelPhase tunnelPhase = TUNNEL_IDLE;
unsigned long tunnelPhaseMs = 0;
bool irAPrev = HIGH, irBPrev = HIGH;

int32_t ldrSmoothedX100 = -1;
unsigned long ldrLastSampleMs = 0;

bool buttonStablePressed = false;
bool buttonRawLast = HIGH;
unsigned long buttonLastChangeMs = 0;
unsigned long buttonPressStartMs = 0;

unsigned long motorStartMs = 0;
bool motorIsOpening = false;

// ── Helpers ────────────────────────────────────────────────────────────────
const char* doorStr(DoorState s) {
  switch (s) {
    case DOOR_OPEN:    return "OPEN";
    case DOOR_CLOSED:  return "CLOSED";
    case DOOR_OPENING: return "OPENING";
    case DOOR_CLOSING: return "CLOSING";
    case DOOR_ERROR:   return "ERROR";
  }
  return "?";
}

void buzzerTone(uint16_t freq, uint16_t ms) {
  ledcWriteTone(LEDC_BUZZER_CHANNEL, freq);
  ledcWrite(LEDC_BUZZER_CHANNEL, 128);
  delay(ms);
  ledcWrite(LEDC_BUZZER_CHANNEL, 0);
}

void motorStop() {
  ledcWrite(LEDC_MOTOR_CHANNEL, 0);
  digitalWrite(PIN_MOTOR_OPEN, LOW);
  digitalWrite(PIN_MOTOR_CLOSE, LOW);
}

void motorDrive(bool opening) {
  digitalWrite(PIN_MOTOR_OPEN,  opening ? HIGH : LOW);
  digitalWrite(PIN_MOTOR_CLOSE, opening ? LOW  : HIGH);
  // Soft-start ramp
  for (int duty = 0; duty <= MOTOR_DUTY_MAX; duty += 8) {
    ledcWrite(LEDC_MOTOR_CHANNEL, duty);
    delay(MOTOR_RAMP_UP_MS * 8 / MOTOR_DUTY_MAX);
  }
}

void startDoor(bool opening) {
  if (doorState == DOOR_OPENING || doorState == DOOR_CLOSING) return;
  motorIsOpening = opening;
  motorStartMs   = millis();
  doorState      = opening ? DOOR_OPENING : DOOR_CLOSING;
  Serial.printf("[DOOR] %s starting\n", doorStr(doorState));
  motorDrive(opening);
}

// ── Setup ──────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\nChickenFlow ESP32-S2 — Wokwi sim boot");

  pinMode(PIN_MOTOR_OPEN,  OUTPUT);
  pinMode(PIN_MOTOR_CLOSE, OUTPUT);
  pinMode(PIN_LED_STATUS,  OUTPUT);
  pinMode(PIN_COOP_LIGHT,  OUTPUT);

  pinMode(PIN_LIMIT_TOP,    INPUT_PULLUP);
  pinMode(PIN_LIMIT_BOTTOM, INPUT_PULLUP);
  pinMode(PIN_IR_SENSOR_A,  INPUT_PULLUP);
  pinMode(PIN_IR_SENSOR_B,  INPUT_PULLUP);
  pinMode(PIN_MANUAL_BUTTON,INPUT_PULLUP);

  ledcSetup(LEDC_BUZZER_CHANNEL, LEDC_BUZZER_FREQ_INIT, LEDC_BUZZER_RESOLUTION);
  ledcAttachPin(PIN_BUZZER, LEDC_BUZZER_CHANNEL);

  ledcSetup(LEDC_MOTOR_CHANNEL, LEDC_MOTOR_FREQ, LEDC_MOTOR_RESOLUTION);
  ledcAttachPin(PIN_MOTOR_PWM, LEDC_MOTOR_CHANNEL);

  analogReadResolution(12);

  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  for (uint8_t addr : { I2C_ADDR_DS3231, I2C_ADDR_INA219, I2C_ADDR_BME280 }) {
    Wire.beginTransmission(addr);
    uint8_t err = Wire.endTransmission();
    Serial.printf("[I2C] 0x%02X %s\n", addr, err == 0 ? "ACK" : "no reply");
  }

  // Boot chirp + 3 LED blinks = ready
  buzzerTone(880, 120);
  for (int i = 0; i < 3; i++) {
    digitalWrite(PIN_LED_STATUS, HIGH); delay(80);
    digitalWrite(PIN_LED_STATUS, LOW);  delay(80);
  }
  digitalWrite(PIN_LED_STATUS, HIGH);

  // Detect initial door state from limit switches
  if (digitalRead(PIN_LIMIT_TOP)    == LOW) doorState = DOOR_OPEN;
  if (digitalRead(PIN_LIMIT_BOTTOM) == LOW) doorState = DOOR_CLOSED;
  Serial.printf("[BOOT] doorState = %s\n", doorStr(doorState));
}

// ── Sensor loops ───────────────────────────────────────────────────────────
void pollLdr() {
  unsigned long now = millis();
  if (now - ldrLastSampleMs < LDR_SAMPLE_MS) return;
  ldrLastSampleMs = now;
  int raw = analogRead(PIN_LDR);
  if (ldrSmoothedX100 < 0) ldrSmoothedX100 = raw * 100;
  else                     ldrSmoothedX100 += (raw * 100 - ldrSmoothedX100) / 10;  // α=0.10
  Serial.printf("[LDR] raw=%4d ema=%4ld\n", raw, ldrSmoothedX100 / 100);
}

void pollIrTunnel() {
  bool a = digitalRead(PIN_IR_SENSOR_A);
  bool b = digitalRead(PIN_IR_SENSOR_B);
  unsigned long now = millis();

  // Timeout a half-completed transit
  if (tunnelPhase != TUNNEL_IDLE && now - tunnelPhaseMs > IR_TUNNEL_TIMEOUT_MS) {
    tunnelPhase = TUNNEL_IDLE;
  }

  if (a == LOW && irAPrev == HIGH) {
    if (tunnelPhase == TUNNEL_B_FIRST) {
      chickensInside = max(0, chickensInside - 1);   // B→A = OUT
      Serial.printf("[TUNNEL] OUT  inside=%d\n", chickensInside);
      tunnelPhase = TUNNEL_IDLE;
    } else {
      tunnelPhase   = TUNNEL_A_FIRST;
      tunnelPhaseMs = now;
    }
  }
  if (b == LOW && irBPrev == HIGH) {
    if (tunnelPhase == TUNNEL_A_FIRST) {
      chickensInside++;                              // A→B = IN
      Serial.printf("[TUNNEL] IN   inside=%d\n", chickensInside);
      tunnelPhase = TUNNEL_IDLE;
    } else {
      tunnelPhase   = TUNNEL_B_FIRST;
      tunnelPhaseMs = now;
    }
  }
  irAPrev = a;
  irBPrev = b;
}

void pollManualButton() {
  bool raw = digitalRead(PIN_MANUAL_BUTTON);
  unsigned long now = millis();
  if (raw != buttonRawLast) {
    buttonRawLast      = raw;
    buttonLastChangeMs = now;
  }
  if (now - buttonLastChangeMs >= BUTTON_DEBOUNCE_MS && raw != (buttonStablePressed ? LOW : HIGH)) {
    buttonStablePressed = (raw == LOW);
    if (buttonStablePressed) {
      buttonPressStartMs = now;
    } else {
      unsigned long held = now - buttonPressStartMs;
      if (held >= BUTTON_PRESS_SERVICE_MS) {
        serviceMode = !serviceMode;
        digitalWrite(PIN_COOP_LIGHT, serviceMode ? HIGH : LOW);
        Serial.printf("[BTN] service mode = %d\n", serviceMode);
        buzzerTone(440, 2000);
      } else if (held >= BUTTON_PRESS_OVERRIDE_MS) {
        Serial.println("[BTN] override: OPEN 15 min");
        buzzerTone(880, 100); delay(80); buzzerTone(880, 100);
        if (doorState == DOOR_CLOSED) startDoor(true);
      }
    }
  }
}

void pollDoorMotion() {
  if (doorState != DOOR_OPENING && doorState != DOOR_CLOSING) return;

  // Limit-switch stop
  if (motorIsOpening && digitalRead(PIN_LIMIT_TOP) == LOW) {
    motorStop();
    doorState = DOOR_OPEN;
    Serial.println("[DOOR] OPEN reached");
  } else if (!motorIsOpening && digitalRead(PIN_LIMIT_BOTTOM) == LOW) {
    motorStop();
    doorState = DOOR_CLOSED;
    Serial.println("[DOOR] CLOSED reached");
  } else if (millis() - motorStartMs > DOOR_TRAVEL_MS_DEFAULT) {
    motorStop();
    doorState = DOOR_ERROR;
    Serial.println("[DOOR] travel timeout — ERROR");
    buzzerTone(220, 1500);
  }
}

// ── Main loop ──────────────────────────────────────────────────────────────
unsigned long lastHeartbeat = 0;

void loop() {
  pollLdr();
  pollIrTunnel();
  pollManualButton();
  pollDoorMotion();

  unsigned long now = millis();
  if (now - lastHeartbeat > 5000) {
    lastHeartbeat = now;
    Serial.printf("[HB] door=%s  inside=%d  svc=%d\n",
                  doorStr(doorState), chickensInside, serviceMode);
  }
}
