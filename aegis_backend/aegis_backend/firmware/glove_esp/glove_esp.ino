// GLOVE ESP32 - MPU6050 gesture sender
// Links:  this ESP -> main ESP via ESP-NOW (driving, 20 packets/s)
//         this ESP <-> laptop hub via WiFi WebSocket (telemetry only)
//
// Needs: ESP32 Arduino core 3.x
// Libraries: "WebSockets" (Markus Sattler), "ArduinoJson" 7.x
// Start the laptop hotspot (2.4 GHz) BEFORE powering the ESPs.

#include <WiFi.h>
#include <esp_now.h>
#include <Wire.h>
#include <math.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>

// ---------------- NETWORK (edit these) ----------------
const char*    WIFI_SSID = "AiPoweredCam";
const char*    WIFI_PASS = "AiPoweredCam7";
const char*    HUB_HOST  = "192.168.137.1";
const uint16_t HUB_PORT  = 8000;
const char*    DEVICE_ID = "glove";

// REPLACE with the MAIN ESP's MAC (main_esp prints it on the Serial Monitor at boot)
uint8_t mainMac[] = { 0x20, 0x50, 0x0D, 0xCE, 0x3E, 0xA4 };

// ---------------- MPU6050 ----------------
#define MPU_ADDR 0x68
#define SDA_PIN 21
#define SCL_PIN 22

// ---------------- SETTINGS ----------------
#define GESTURE_THRESHOLD   12.0   // degrees to START a gesture
#define GESTURE_HYSTERESIS   3.0   // gesture ends only after falling this far back (stops flicker)
#define ALPHA 0.96

#define SENSOR_INTERVAL    10
#define SEND_INTERVAL      50
#define PRINT_INTERVAL    200
#define TELEMETRY_INTERVAL 200

// Same struct as main_esp.ino
struct __attribute__((packed)) GlovePacket {
  char     cmd;
  uint16_t seq;
};

WebSocketsClient ws;

// ---------------- DATA ----------------
float pitch = 0, roll = 0;
float neutralPitch = 0, neutralRoll = 0;
float gyroBiasX = 0, gyroBiasY = 0;
float accelX, accelY, accelZ;
float gyroX, gyroY, gyroZ;

unsigned long lastSensorTime = 0;
unsigned long lastSendTime = 0;
unsigned long lastPrintTime = 0;

char currentCommand = 'S';
uint16_t packetSeq = 0;
uint32_t packetsSent = 0;
uint32_t sendErrors = 0;

// ---------------- MPU FUNCTIONS ----------------
bool readMPU() {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x3B);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(MPU_ADDR, 14, true) != 14) return false;

  int16_t ax = Wire.read() << 8 | Wire.read();
  int16_t ay = Wire.read() << 8 | Wire.read();
  int16_t az = Wire.read() << 8 | Wire.read();
  Wire.read(); Wire.read();                       // temperature
  int16_t gx = Wire.read() << 8 | Wire.read();
  int16_t gy = Wire.read() << 8 | Wire.read();
  int16_t gz = Wire.read() << 8 | Wire.read();

  accelX = ax / 4096.0;  accelY = ay / 4096.0;  accelZ = az / 4096.0;
  gyroX  = gx / 65.5;    gyroY  = gy / 65.5;    gyroZ  = gz / 65.5;
  return true;
}

void initializeMPU() {
  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(100000);

  Wire.beginTransmission(MPU_ADDR); Wire.write(0x6B); Wire.write(0x00); Wire.endTransmission();
  delay(100);
  Wire.beginTransmission(MPU_ADDR); Wire.write(0x1C); Wire.write(0x10); Wire.endTransmission();  // +/-8 g
  Wire.beginTransmission(MPU_ADDR); Wire.write(0x1B); Wire.write(0x08); Wire.endTransmission();  // +/-500 deg/s
  Serial.println("MPU6050 initialized");
}

void calibrateMPU() {
  Serial.println("\nKeep your hand FLAT and STILL.");
  Serial.println("Calibration starts in 3 seconds...");
  delay(3000);

  float sumPitch = 0, sumRoll = 0, sumGyroX = 0, sumGyroY = 0;
  int samples = 0;

  for (int i = 0; i < 100; i++) {
    if (readMPU()) {
      sumPitch += atan2(-accelX, sqrt(accelY * accelY + accelZ * accelZ)) * RAD_TO_DEG;
      sumRoll  += atan2(accelY, accelZ) * RAD_TO_DEG;
      sumGyroX += gyroX;
      sumGyroY += gyroY;
      samples++;
    }
    delay(20);
  }

  if (samples == 0) {
    Serial.println("MPU6050 reading failed!");
    while (true) delay(1000);
  }

  neutralPitch = sumPitch / samples;
  neutralRoll  = sumRoll / samples;
  gyroBiasX = sumGyroX / samples;
  gyroBiasY = sumGyroY / samples;
  pitch = neutralPitch;
  roll  = neutralRoll;

  Serial.println("Calibration completed!");
}

// ---------------- GESTURE DETECTION (with hysteresis) ----------------
char detectGesture() {
  float dp = pitch - neutralPitch;
  float dr = roll - neutralRoll;
  float exitT = GESTURE_THRESHOLD - GESTURE_HYSTERESIS;

  // keep the current gesture until it falls back inside the exit band
  switch (currentCommand) {
    case 'B': if (dp < -exitT) return 'B'; break;
    case 'F': if (dp >  exitT) return 'F'; break;
    case 'L': if (dr < -exitT) return 'L'; break;
    case 'R': if (dr >  exitT) return 'R'; break;
  }

  if (dp < -GESTURE_THRESHOLD) return 'B';
  if (dp >  GESTURE_THRESHOLD) return 'F';
  if (dr < -GESTURE_THRESHOLD) return 'L';
  if (dr >  GESTURE_THRESHOLD) return 'R';
  return 'S';
}

// ---------------- HUB LINK ----------------
void onWsEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:    Serial.println("[HUB] connected"); break;
    case WStype_DISCONNECTED: Serial.println("[HUB] disconnected"); break;
    case WStype_TEXT: {
      JsonDocument doc;
      if (deserializeJson(doc, payload, length)) return;
      if (!strcmp(doc["cmd"] | "", "ping")) {
        JsonDocument r;
        r["type"] = "pong";
        r["n"] = doc["n"].as<int>();
        char buf[64];
        size_t n = serializeJson(r, buf, sizeof(buf));
        ws.sendTXT((uint8_t*)buf, n);
      }
      break;
    }
    default: break;
  }
}

void sendTelemetry() {
  static unsigned long last = 0;
  static uint32_t seq = 0;
  if (millis() - last < TELEMETRY_INTERVAL) return;
  last = millis();
  if (!ws.isConnected()) return;

  JsonDocument doc;
  doc["device"] = DEVICE_ID;
  doc["seq"] = seq++;
  doc["uptime_ms"] = millis();
  doc["rssi"] = WiFi.RSSI();
  JsonObject d = doc["data"].to<JsonObject>();
  d["pitch_deg"] = pitch - neutralPitch;
  d["roll_deg"] = roll - neutralRoll;
  d["command"] = String(currentCommand);
  d["packets_sent"] = packetsSent;
  d["send_errors"] = sendErrors;
  char buf[320];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  ws.sendTXT((uint8_t*)buf, n);
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

void startNetwork() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  if (esp_now_init() != ESP_OK) {
    Serial.println("[ESPNOW] init failed");
    while (true) delay(1000);
  }
  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, mainMac, 6);
  peer.channel = 0;            // 0 = whatever channel the hotspot is on
  peer.encrypt = false;
  if (esp_now_add_peer(&peer) != ESP_OK) {
    Serial.println("[ESPNOW] add peer failed");
  }

  char url[32];
  snprintf(url, sizeof(url), "/ws/%s", DEVICE_ID);
  ws.begin(HUB_HOST, HUB_PORT, url);
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(2000);
  ws.enableHeartbeat(10000, 3000, 2);
}

// ---------------- SETUP ----------------
void setup() {
  Serial.begin(115200);
  delay(1000);

  initializeMPU();
  calibrateMPU();
  startNetwork();

  lastSensorTime = lastSendTime = lastPrintTime = millis();
  Serial.println("\nGesture control started (ESP-NOW + hub telemetry)!");
}

// ---------------- LOOP ----------------
void loop() {
  unsigned long now = millis();

  if (now - lastSensorTime >= SENSOR_INTERVAL) {
    float dt = (now - lastSensorTime) / 1000.0;
    lastSensorTime = now;

    if (readMPU()) {
      float accelPitch = atan2(-accelX, sqrt(accelY * accelY + accelZ * accelZ)) * RAD_TO_DEG;
      float accelRoll  = atan2(accelY, accelZ) * RAD_TO_DEG;

      pitch = ALPHA * (pitch + (gyroY - gyroBiasY) * dt) + (1.0 - ALPHA) * accelPitch;
      roll  = ALPHA * (roll  + (gyroX - gyroBiasX) * dt) + (1.0 - ALPHA) * accelRoll;

      currentCommand = detectGesture();
    }
  }

  // Driving command to the main ESP, every 50 ms (never waits for the laptop)
  if (now - lastSendTime >= SEND_INTERVAL) {
    lastSendTime = now;
    GlovePacket p = { currentCommand, packetSeq++ };
    if (esp_now_send(mainMac, (uint8_t*)&p, sizeof(p)) == ESP_OK) packetsSent++;
    else sendErrors++;
  }

  wifiKeepAlive();
  if (WiFi.status() == WL_CONNECTED) ws.loop();
  sendTelemetry();

  if (now - lastPrintTime >= PRINT_INTERVAL) {
    lastPrintTime = now;
    Serial.printf("Pitch: %.1f | Roll: %.1f | CMD: %c | sent=%lu err=%lu\n",
                  pitch - neutralPitch, roll - neutralRoll, currentCommand,
                  (unsigned long)packetsSent, (unsigned long)sendErrors);
  }
}
