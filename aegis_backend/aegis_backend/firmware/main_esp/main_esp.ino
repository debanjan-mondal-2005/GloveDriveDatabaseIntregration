// MAIN ESP32 - motors, ultrasonic, MQ gas, DHT11, servo
// Links:  glove -> this ESP via ESP-NOW (driving)     this ESP <-> laptop hub via WiFi WebSocket
//
// Needs: ESP32 Arduino core 3.x
// Libraries: "WebSockets" (Markus Sattler), "ArduinoJson" 7.x, "DHT sensor library" + "Adafruit Unified Sensor"
// Board: ESP32 Dev Module. Start the laptop hotspot (2.4 GHz) BEFORE powering the ESPs.

#include <WiFi.h>
#include <esp_now.h>
#include <Preferences.h>
#include <DHT.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>

// ---------------- NETWORK (edit these) ----------------
const char*    WIFI_SSID = "AiPoweredCam";
const char*    WIFI_PASS = "AiPoweredCam7";
const char*    HUB_HOST  = "192.168.137.1";    // Windows hotspot always gives the laptop this address
const uint16_t HUB_PORT  = 8000;
const char*    DEVICE_ID = "main";

#define TELEMETRY_MS           200     // 5 messages per second to the hub
#define COMMUNICATION_TIMEOUT  500     // ESP-NOW: stop the car if no glove packet for this long (ms)
#define WIFI_SCAN_MS           30000UL // non-blocking nearby Wi-Fi scan interval while car is ON
#define WIFI_SCAN_BOOT_MS      2500UL  // initial scan shortly after connecting to hub
#define WIFI_SCAN_MAX_APS      12      // strongest APs sent to hub for geolocation

#define DEFAULT_STOP_CM  20
#define BEEP_ZONE_CM     40

// ---------------- MOTOR PINS ----------------
#define ENA 25
#define IN1 26
#define IN2 27
#define IN3 18
#define IN4 19
#define ENB 33

// ---------------- SENSOR + BUZZER PINS ----------------
#define TRIG_PIN   13
#define ECHO_PIN   14
#define BUZZER_PIN 23

#define DHT_PIN    4
#define DHT_TYPE   DHT11
#define GAS_PIN    34
#define ENV_READ_MS      2000
#define GAS_WARN_RAW     1500
#define GAS_DANGER_RAW   2500

// ---------------- SERVO ----------------
#define SERVO_PIN            32
#define SERVO_MIN_US         500
#define SERVO_MAX_US         2400
#define SERVO_STEP_MS        30     // auto sweep speed
#define SERVO_MANUAL_STEP_MS 8      // speed when the hub sets an angle (about 125 deg/s)

// ---------------- GLOVE PACKET (same struct as glove_esp.ino) ----------------
struct __attribute__((packed)) GlovePacket {
  char     cmd;      // F B L R S
  uint16_t seq;
};

// ---------------- OBJECTS ----------------
Preferences prefs;
DHT dht(DHT_PIN, DHT_TYPE);
WebSocketsClient ws;

// ---------------- STATE ----------------
int  speedA = 0;
int  speedB = 0;
char dirState = 'S';

int  stopDist = DEFAULT_STOP_CM;
int  warnDist = DEFAULT_STOP_CM + BEEP_ZONE_CM;

int  distanceCm = 999;
int  nearCount = 0;
bool blocked = false;
bool prevBlocked = false;

float temperature = 0;
float humidity = 0;
bool  hasDht = false;
bool  dhtOk = false;
int   gasRaw = 0;

volatile char     receivedCommand = 'S';
volatile uint32_t lastPacketTime = 0;
volatile uint32_t glovePackets = 0;
char previousCommand = '\0';

int  servoAngle = 0;
int  servoDir = 1;
bool servoManual = false;
int  servoTarget = 90;

// ---------------- MOTOR CONTROL ----------------
void stopMotors() {
  digitalWrite(IN1, LOW); digitalWrite(IN2, LOW);
  digitalWrite(IN3, LOW); digitalWrite(IN4, LOW);
  analogWrite(ENA, 0);
  analogWrite(ENB, 0);
}

void applyMotors() {
  if (dirState == 'F' && blocked) {      // obstacle failsafe stays on this ESP
    stopMotors();
    return;
  }
  switch (dirState) {
    case 'F':
      digitalWrite(IN1, HIGH); digitalWrite(IN2, LOW);
      digitalWrite(IN3, HIGH); digitalWrite(IN4, LOW);
      break;
    case 'B':
      digitalWrite(IN1, LOW);  digitalWrite(IN2, HIGH);
      digitalWrite(IN3, LOW);  digitalWrite(IN4, HIGH);
      break;
    case 'L':
      digitalWrite(IN1, LOW);  digitalWrite(IN2, HIGH);
      digitalWrite(IN3, HIGH); digitalWrite(IN4, LOW);
      break;
    case 'R':
      digitalWrite(IN1, HIGH); digitalWrite(IN2, LOW);
      digitalWrite(IN3, LOW);  digitalWrite(IN4, HIGH);
      break;
    default:
      stopMotors();
      return;
  }
  analogWrite(ENA, map(speedA, 0, 100, 0, 255));
  analogWrite(ENB, map(speedB, 0, 100, 0, 255));
}

void fixDistances() {
  stopDist = constrain(stopDist, 5, 100);
  warnDist = stopDist + BEEP_ZONE_CM;
}

void saveSettings() {
  prefs.putInt("a", speedA);
  prefs.putInt("b", speedB);
  prefs.putInt("p", stopDist);
}

// ---------------- ULTRASONIC + BUZZER ----------------
int readDistanceCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  unsigned long duration = pulseIn(ECHO_PIN, HIGH, 15000);
  if (duration == 0) return 999;
  return (int)(duration * 0.0343 / 2.0);
}

void updateBuzzer() {
  static unsigned long lastBeep = 0;
  static unsigned long beepOffTime = 0;

  if (distanceCm >= warnDist) { digitalWrite(BUZZER_PIN, LOW); return; }
  if (blocked || distanceCm <= stopDist) { digitalWrite(BUZZER_PIN, HIGH); return; }

  int period = map(distanceCm, stopDist, warnDist, 100, 700);
  period = constrain(period, 100, 700);

  unsigned long now = millis();
  if (now - lastBeep >= (unsigned long)period) {
    lastBeep = now;
    beepOffTime = now + 40;
  }
  digitalWrite(BUZZER_PIN, (long)(beepOffTime - now) > 0 ? HIGH : LOW);
}

void updateSensor() {
  static unsigned long lastMeasure = 0;
  if (millis() - lastMeasure >= 60) {
    lastMeasure = millis();
    distanceCm = readDistanceCm();

    if (distanceCm <= stopDist) nearCount = min(nearCount + 1, 5);
    else nearCount = 0;
    blocked = (nearCount >= 2);

    if (blocked != prevBlocked) {
      prevBlocked = blocked;
      Serial.println(blocked ? "[SENSOR] Object close -> forward BLOCKED" : "[SENSOR] Path clear");
      applyMotors();
    }
  }
  updateBuzzer();
}

// ---------------- DHT11 + MQ GAS ----------------
int readGasRaw() {
  long sum = 0;
  for (int i = 0; i < 10; i++) {
    sum += analogRead(GAS_PIN);
    delayMicroseconds(200);
  }
  return (int)(sum / 10);
}

const char* gasStatus() {
  if (gasRaw >= GAS_DANGER_RAW) return "DANGER";
  if (gasRaw >= GAS_WARN_RAW)   return "Warning";
  return "Normal";
}

void updateEnvSensors() {
  static unsigned long lastRead = 0;
  if (millis() - lastRead < ENV_READ_MS) return;
  lastRead = millis();

  float h = dht.readHumidity();
  float t = dht.readTemperature();
  if (!isnan(h) && !isnan(t)) {
    humidity = h; temperature = t; hasDht = true; dhtOk = true;
  } else {
    dhtOk = false;
    Serial.println("[DHT11] Read failed - check wiring");
  }
  gasRaw = readGasRaw();
}

// ---------------- SERVO ----------------
void servoWrite(int angle) {
  int us = map(angle, 0, 180, SERVO_MIN_US, SERVO_MAX_US);
  uint32_t duty = (uint32_t)((uint64_t)us * 65535 / 20000);
  ledcWrite(SERVO_PIN, duty);
}

// Auto sweep 0->180->0, or glide to the angle the hub asked for. Never blocks.
void updateServo() {
  static unsigned long lastStep = 0;
  unsigned long interval = servoManual ? SERVO_MANUAL_STEP_MS : SERVO_STEP_MS;
  if (millis() - lastStep < interval) return;
  lastStep = millis();

  if (servoManual) {
    if (servoAngle < servoTarget) servoAngle++;
    else if (servoAngle > servoTarget) servoAngle--;
    else return;
  } else {
    servoAngle += servoDir;
    if (servoAngle >= 180) { servoAngle = 180; servoDir = -1; }
    else if (servoAngle <= 0) { servoAngle = 0; servoDir = 1; }
  }
  servoWrite(servoAngle);
}

// ---------------- GLOVE (ESP-NOW) ----------------
void onEspNowRecv(const esp_now_recv_info_t* info, const uint8_t* data, int len) {
  if (len != (int)sizeof(GlovePacket)) return;
  GlovePacket p;
  memcpy(&p, data, sizeof(p));
  if (p.cmd == 'F' || p.cmd == 'B' || p.cmd == 'L' || p.cmd == 'R' || p.cmd == 'S') {
    receivedCommand = p.cmd;
    lastPacketTime = millis();
    glovePackets++;
  }
}

void processCommand(char cmd) {
  switch (cmd) {
    case 'F': dirState = 'F'; Serial.println("[CAR] FORWARD");  break;
    case 'B': dirState = 'B'; Serial.println("[CAR] BACKWARD"); break;
    case 'L': dirState = 'L'; Serial.println("[CAR] LEFT");     break;
    case 'R': dirState = 'R'; Serial.println("[CAR] RIGHT");    break;
    default:  dirState = 'S'; Serial.println("[CAR] STOP");     break;
  }
  applyMotors();
}

bool gloveLinkUp() {
  return lastPacketTime != 0 && millis() - lastPacketTime <= COMMUNICATION_TIMEOUT;
}

void gloveLoop() {
  char command = receivedCommand;
  if (!gloveLinkUp()) command = 'S';          // link lost -> stop

  if (command != previousCommand) {
    processCommand(command);
    previousCommand = command;
  }
}

// ---------------- HUB LINK (WebSocket) ----------------
void sendJson(JsonDocument& doc) {
  char buf[640];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  ws.sendTXT((uint8_t*)buf, n);
}

void handleHubMessage(uint8_t* payload, size_t length) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, length)) return;
  const char* cmd = doc["cmd"] | "";

  if (!strcmp(cmd, "ping")) {
    JsonDocument r;
    r["type"] = "pong";
    r["n"] = doc["n"].as<int>();
    sendJson(r);
  }
  else if (!strcmp(cmd, "servo")) {
    if (doc["angle"].is<int>()) {
      servoTarget = constrain(doc["angle"].as<int>(), 0, 180);
      servoManual = true;
    } else if (!strcmp(doc["mode"] | "", "sweep")) {
      servoManual = false;
    }
  }
  else if (!strcmp(cmd, "config")) {
    bool changed = false;
    if (doc["speedA"].is<int>())  { speedA = constrain(doc["speedA"].as<int>(), 0, 100); changed = true; }
    if (doc["speedB"].is<int>())  { speedB = constrain(doc["speedB"].as<int>(), 0, 100); changed = true; }
    if (doc["stop_cm"].is<int>()) { stopDist = doc["stop_cm"].as<int>(); changed = true; }
    if (changed) {
      fixDistances();
      saveSettings();
      applyMotors();
      Serial.printf("[CONFIG] A=%d%% B=%d%% stop=%dcm\n", speedA, speedB, stopDist);
    }
  }
}

void onWsEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:    Serial.println("[HUB] connected"); break;
    case WStype_DISCONNECTED: Serial.println("[HUB] disconnected"); break;
    case WStype_TEXT:         handleHubMessage(payload, length); break;
    default: break;
  }
}

void sendTelemetry() {
  static unsigned long last = 0;
  static uint32_t seq = 0;
  if (millis() - last < TELEMETRY_MS) return;
  last = millis();
  if (!ws.isConnected()) return;

  JsonDocument doc;
  doc["device"] = DEVICE_ID;
  doc["seq"] = seq++;
  doc["uptime_ms"] = millis();
  doc["rssi"] = WiFi.RSSI();
  JsonObject d = doc["data"].to<JsonObject>();
  d["distance_cm"] = distanceCm;
  if (hasDht) { d["temp_c"] = temperature; d["hum_pct"] = humidity; }
  else        { d["temp_c"] = nullptr;     d["hum_pct"] = nullptr; }
  d["dht_ok"] = dhtOk;
  d["gas_raw"] = gasRaw;
  d["gas_state"] = gasStatus();
  d["blocked"] = blocked;
  d["dir"] = String(dirState);
  d["servo"] = servoAngle;
  d["servo_mode"] = servoManual ? "manual" : "sweep";
  d["speedA"] = speedA;
  d["speedB"] = speedB;
  d["stop_cm"] = stopDist;
  d["glove_link"] = gloveLinkUp();
  d["glove_packets"] = (uint32_t)glovePackets;
  d["heap"] = ESP.getFreeHeap();
  sendJson(doc);
}

// ---------------- WIFI ----------------
void updateWifiLocationScan() {
  static bool          scanRunning = false;
  static bool          didFirstScan = false;
  static unsigned long lastScanStartMs = 0;
  static unsigned long wsUpSinceMs = 0;

  unsigned long now = millis();
  bool carActive = (WiFi.status() == WL_CONNECTED && ws.isConnected());

  if (!carActive) {
    if (scanRunning && WiFi.scanComplete() != WIFI_SCAN_RUNNING) {
      WiFi.scanDelete();
      scanRunning = false;
    }
    wsUpSinceMs = 0;
    didFirstScan = false;
    return;
  }

  if (wsUpSinceMs == 0) wsUpSinceMs = now;

  if (scanRunning) {
    int16_t res = WiFi.scanComplete();
    if (res == WIFI_SCAN_RUNNING) return; // still scanning in background RTOS task

    scanRunning = false;
    if (res > 0) {
      // Pick strongest AP indices (by RSSI descending) without blocking or large allocations
      int topIdx[WIFI_SCAN_MAX_APS];
      int topRssi[WIFI_SCAN_MAX_APS];
      int count = 0;

      for (int i = 0; i < res; i++) {
        uint8_t* bssid = WiFi.BSSID(i);
        if (!bssid) continue;
        int rssi = WiFi.RSSI(i);
        if (count < WIFI_SCAN_MAX_APS) {
          topIdx[count] = i;
          topRssi[count] = rssi;
          count++;
        } else {
          int minPos = 0;
          for (int j = 1; j < WIFI_SCAN_MAX_APS; j++) {
            if (topRssi[j] < topRssi[minPos]) minPos = j;
          }
          if (rssi > topRssi[minPos]) {
            topIdx[minPos] = i;
            topRssi[minPos] = rssi;
          }
        }
      }

      if (count > 0) {
        JsonDocument doc;
        doc["device"] = DEVICE_ID;
        doc["type"] = "wifi_scan";
        doc["uptime_ms"] = now;
        JsonArray aps = doc["aps"].to<JsonArray>();
        for (int k = 0; k < count; k++) {
          int idx = topIdx[k];
          uint8_t* bssid = WiFi.BSSID(idx);
          if (!bssid) continue;
          char mac[18];
          snprintf(mac, sizeof(mac), "%02x:%02x:%02x:%02x:%02x:%02x",
                   bssid[0], bssid[1], bssid[2], bssid[3], bssid[4], bssid[5]);
          JsonObject ap = aps.add<JsonObject>();
          ap["bssid"] = mac;
          ap["rssi"] = WiFi.RSSI(idx);
          ap["ch"] = WiFi.channel(idx);
        }
        String payload;
        serializeJson(doc, payload);
        ws.sendTXT(payload);
        Serial.printf("[LOC] Sent %d Wi-Fi APs for geolocation\n", count);
      }
    }
    WiFi.scanDelete();
    return;
  }

  bool scanDue = !didFirstScan
    ? (now - wsUpSinceMs >= WIFI_SCAN_BOOT_MS)
    : (now - lastScanStartMs >= WIFI_SCAN_MS);

  if (scanDue) {
    didFirstScan = true;
    lastScanStartMs = now;
    int16_t st = WiFi.scanNetworks(true, false); // async=true, show_hidden=false
    if (st == WIFI_SCAN_RUNNING) {
      scanRunning = true;
    } else if (st >= 0) {
      scanRunning = true; // collect on next loop tick
    }
  }
}

void wifiKeepAlive() {
  static unsigned long lastTry = 0;
  static bool wasConnected = false;
  bool connected = (WiFi.status() == WL_CONNECTED);

  if (connected && !wasConnected) {
    Serial.print("[WIFI] connected, IP ");
    Serial.print(WiFi.localIP());
    Serial.print("  channel ");
    Serial.println(WiFi.channel());
  }
  if (!connected && millis() - lastTry > 8000) {
    lastTry = millis();
    Serial.println("[WIFI] reconnecting...");
    WiFi.disconnect(false);
    WiFi.begin(WIFI_SSID, WIFI_PASS);
  }
  wasConnected = connected;
}

// ---------------- SETUP ----------------
void setup() {
  Serial.begin(115200);
  delay(500);

  pinMode(ENA, OUTPUT); pinMode(IN1, OUTPUT); pinMode(IN2, OUTPUT);
  pinMode(ENB, OUTPUT); pinMode(IN3, OUTPUT); pinMode(IN4, OUTPUT);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(TRIG_PIN, LOW);
  digitalWrite(BUZZER_PIN, LOW);

  analogWriteResolution(ENA, 8);
  analogWriteResolution(ENB, 8);
  analogWriteFrequency(ENA, 2000);
  analogWriteFrequency(ENB, 2000);

  dht.begin();
  pinMode(GAS_PIN, INPUT);
  analogReadResolution(12);
  analogSetPinAttenuation(GAS_PIN, ADC_11db);

  ledcAttach(SERVO_PIN, 50, 16);
  servoWrite(0);

  prefs.begin("motors", false);          // speeds you saved earlier are still here
  speedA   = prefs.getInt("a", 0);
  speedB   = prefs.getInt("b", 0);
  stopDist = prefs.getInt("p", DEFAULT_STOP_CM);
  fixDistances();
  if (speedA == 0 || speedB == 0) {
    Serial.println("[SYSTEM] WARNING: a motor speed is 0% - set it from the hub page");
  }
  stopMotors();

  // WiFi station + ESP-NOW (both use the same radio channel as the hotspot)
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  Serial.print("[ESPNOW] This ESP's MAC (put it in glove_esp.ino): ");
  Serial.println(WiFi.macAddress());

  if (esp_now_init() != ESP_OK) {
    Serial.println("[ESPNOW] init failed");
  } else {
    esp_now_register_recv_cb(onEspNowRecv);
    Serial.println("[ESPNOW] ready, waiting for glove");
  }

  char url[32];
  snprintf(url, sizeof(url), "/ws/%s", DEVICE_ID);
  ws.begin(HUB_HOST, HUB_PORT, url);
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(2000);
  ws.enableHeartbeat(10000, 3000, 2);
}

// ---------------- LOOP ----------------
void loop() {
  updateSensor();
  updateEnvSensors();
  updateServo();
  gloveLoop();

  wifiKeepAlive();
  if (WiFi.status() == WL_CONNECTED) ws.loop();
  updateWifiLocationScan();
  sendTelemetry();

  delay(1);
}
