// ESP32-CAM (AI-Thinker pinout) - camera WITHOUT hardware JPEG
// The sensor outputs raw pixels (RGB565 / YUV422 / GRAYSCALE). The ESP converts each frame to JPEG in
// software (frame2jpg), so the hub still pulls a normal MJPEG stream from http://<cam-ip>:81/stream.
//
// Arduino IDE: Board = "AI Thinker ESP32-CAM", Partition Scheme = "Huge APP (3MB No OTA/1MB SPIFFS)"
//              Tools -> PSRAM = "Enabled"  (raw frames are big; needed for QVGA)
// Libraries: "WebSockets" (Markus Sattler), "ArduinoJson" 7.x
// Power it from a solid 5 V supply (>= 500 mA).

#include "esp_camera.h"
#include "img_converters.h"
#include <WiFi.h>
#include "esp_http_server.h"
#include <WebSocketsClient.h>
#include <ArduinoJson.h>

// ---------------- NETWORK (edit these) ----------------
const char*    WIFI_SSID = "AiPoweredCam";
const char*    WIFI_PASS = "AiPoweredCam7";
const char*    HUB_HOST  = "192.168.137.1";
const uint16_t HUB_PORT  = 8000;
const char*    DEVICE_ID = "cam";

#define HEARTBEAT_MS    1000

// ---------------- CAMERA SETTINGS ----------------
// Pick ONE pixel format. If camera init fails, try the next one.
//   PIXFORMAT_RGB565    colour, 2 bytes/pixel  (try this first)
//   PIXFORMAT_YUV422    colour, 2 bytes/pixel
//   PIXFORMAT_GRAYSCALE black & white, 1 byte/pixel (smallest, fastest)
#define PIXEL_FORMAT    PIXFORMAT_RGB565
#define FRAME_SIZE      FRAMESIZE_QVGA       // 320x240. Use FRAMESIZE_QQVGA (160x120) if it is slow or runs out of memory
#define JPEG_OUT_QUALITY 60                  // software JPEG quality: 1-100, HIGHER = better picture, bigger frame
#define XCLK_HZ         20000000             // try 10000000 if init or the picture is unstable
#define FLIP_VERTICAL   false
#define FLIP_MIRROR     false

// ---------------- AI-THINKER CAMERA PINS ----------------
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27
#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22

// ---------------- WEB SERVER ----------------
#define PART_BOUNDARY "123456789000000000000987654321"
static const char* STREAM_CONTENT_TYPE = "multipart/x-mixed-replace;boundary=" PART_BOUNDARY;
static const char* STREAM_BOUNDARY     = "\r\n--" PART_BOUNDARY "\r\n";
static const char* STREAM_PART         = "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n";

httpd_handle_t pageServer   = NULL;   // port 80: page + single photo (/capture)
httpd_handle_t streamServer = NULL;   // port 81: live video (ONE viewer at a time: the laptop)

WebSocketsClient ws;
volatile uint32_t framesServed = 0;
bool     camOk  = false;
esp_err_t camErr = ESP_OK;

static const char INDEX_HTML[] =
  "<!DOCTYPE html><html><head><meta name='viewport' content='width=device-width, initial-scale=1'>"
  "<title>Car Cam</title>"
  "<style>body{font-family:sans-serif;background:#111;color:#eee;text-align:center;margin:0;padding:12px}"
  "a{color:#4fc3f7}</style></head><body>"
  "<h3>Car Cam</h3>"
  "<p>The live stream is read by the laptop hub (port 81 serves one viewer at a time).</p>"
  "<p><a href='/capture' target='_blank'>Take photo</a></p>"
  "</body></html>";

static esp_err_t index_handler(httpd_req_t *req) {
  httpd_resp_set_type(req, "text/html");
  return httpd_resp_send(req, INDEX_HTML, strlen(INDEX_HTML));
}

// Grab one raw frame and convert it to JPEG in software. Caller must free(*jpg).
static bool grabJpeg(uint8_t **jpg, size_t *jpgLen) {
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) return false;
  bool ok = frame2jpg(fb, JPEG_OUT_QUALITY, jpg, jpgLen);
  esp_camera_fb_return(fb);
  return ok;
}

static esp_err_t capture_handler(httpd_req_t *req) {
  uint8_t *jpg = NULL;
  size_t len = 0;
  if (!grabJpeg(&jpg, &len)) {
    httpd_resp_send_500(req);
    return ESP_FAIL;
  }
  httpd_resp_set_type(req, "image/jpeg");
  httpd_resp_set_hdr(req, "Content-Disposition", "inline; filename=capture.jpg");
  esp_err_t res = httpd_resp_send(req, (const char*)jpg, len);
  free(jpg);
  return res;
}

static esp_err_t stream_handler(httpd_req_t *req) {
  esp_err_t res = httpd_resp_set_type(req, STREAM_CONTENT_TYPE);
  if (res != ESP_OK) return res;
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");

  char partBuf[64];
  while (true) {
    uint8_t *jpg = NULL;
    size_t len = 0;
    if (!grabJpeg(&jpg, &len)) {
      Serial.println("[CAM] Frame capture/convert failed");
      res = ESP_FAIL;
      break;
    }

    size_t hlen = snprintf(partBuf, sizeof(partBuf), STREAM_PART, (unsigned)len);
    res = httpd_resp_send_chunk(req, STREAM_BOUNDARY, strlen(STREAM_BOUNDARY));
    if (res == ESP_OK) res = httpd_resp_send_chunk(req, partBuf, hlen);
    if (res == ESP_OK) res = httpd_resp_send_chunk(req, (const char*)jpg, len);
    free(jpg);

    if (res != ESP_OK) break;      // viewer closed
    framesServed++;
  }
  return res;
}

void startServers() {
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.stack_size = 8192;        // software JPEG encoding needs more stack than the default

  httpd_uri_t indexUri   = { "/",        HTTP_GET, index_handler,   NULL };
  httpd_uri_t captureUri = { "/capture", HTTP_GET, capture_handler, NULL };
  httpd_uri_t streamUri  = { "/stream",  HTTP_GET, stream_handler,  NULL };

  config.server_port = 80;
  if (httpd_start(&pageServer, &config) == ESP_OK) {
    httpd_register_uri_handler(pageServer, &indexUri);
    httpd_register_uri_handler(pageServer, &captureUri);
  }

  config.server_port = 81;
  config.ctrl_port  += 1;
  if (httpd_start(&streamServer, &config) == ESP_OK) {
    httpd_register_uri_handler(streamServer, &streamUri);
  }
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

void sendHeartbeat() {
  static unsigned long last = 0;
  static uint32_t seq = 0, prevFrames = 0;
  unsigned long now = millis();
  if (now - last < HEARTBEAT_MS) return;
  float fps = (framesServed - prevFrames) * 1000.0 / (now - last);
  prevFrames = framesServed;
  last = now;
  if (!ws.isConnected()) return;

  char errHex[12];
  snprintf(errHex, sizeof(errHex), "0x%X", (unsigned)camErr);

  JsonDocument doc;
  doc["device"] = DEVICE_ID;
  doc["seq"] = seq++;
  doc["uptime_ms"] = now;
  doc["rssi"] = WiFi.RSSI();
  JsonObject d = doc["data"].to<JsonObject>();
  d["cam_ok"] = camOk;                    // false = camera failed to start (see cam_err)
  d["cam_err"] = errHex;
  d["fps"] = fps;
  d["free_heap"] = ESP.getFreeHeap();
  d["free_psram"] = ESP.getFreePsram();
  d["ip"] = WiFi.localIP().toString();
  char buf[360];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  ws.sendTXT((uint8_t*)buf, n);
}

void wifiKeepAlive() {
  static unsigned long lastTry = 0;
  static bool wasConnected = false;
  bool connected = (WiFi.status() == WL_CONNECTED);

  if (connected && !wasConnected) {
    Serial.print("[CAM] WiFi connected. Stream: http://");
    Serial.print(WiFi.localIP());
    Serial.println(":81/stream");
  }
  if (!connected && millis() - lastTry > 8000) {
    lastTry = millis();
    Serial.println("[CAM] WiFi reconnecting...");
    WiFi.disconnect(false);
    WiFi.begin(WIFI_SSID, WIFI_PASS);
  }
  wasConnected = connected;
}

// ---------------- CAMERA ----------------
bool startCamera() {
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer   = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk     = XCLK_GPIO_NUM;
  config.pin_pclk     = PCLK_GPIO_NUM;
  config.pin_vsync    = VSYNC_GPIO_NUM;
  config.pin_href     = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn     = PWDN_GPIO_NUM;
  config.pin_reset    = RESET_GPIO_NUM;
  config.xclk_freq_hz = XCLK_HZ;
  config.pixel_format = PIXEL_FORMAT;          // raw pixels, no hardware JPEG
  config.frame_size   = FRAME_SIZE;
  config.jpeg_quality = 12;                    // unused for raw formats
  config.fb_location  = CAMERA_FB_IN_PSRAM;
  config.grab_mode    = CAMERA_GRAB_LATEST;

  if (psramFound()) {
    config.fb_count = 2;
  } else {
    Serial.println("[CAM] No PSRAM found - using 160x120 in internal RAM (enable PSRAM in Tools menu if your board has it)");
    config.fb_count = 1;
    config.fb_location = CAMERA_FB_IN_DRAM;
    config.frame_size = FRAMESIZE_QQVGA;
  }

  camErr = esp_camera_init(&config);
  if (camErr != ESP_OK) {
    Serial.printf("[CAM] Camera init FAILED (0x%x)\n", (unsigned)camErr);
    Serial.println("      0x105 = camera not detected (ribbon cable / wrong pins / power)");
    Serial.println("      0x106 = this pixel format is not supported -> change PIXEL_FORMAT");
    Serial.println("      0x101 = out of memory -> enable PSRAM or use FRAMESIZE_QQVGA");
    return false;
  }

  sensor_t *s = esp_camera_sensor_get();
  if (s) {
    s->set_vflip(s, FLIP_VERTICAL ? 1 : 0);
    s->set_hmirror(s, FLIP_MIRROR ? 1 : 0);
  }
  return true;
}

// ---------------- SETUP ----------------
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n[CAM] Starting (non-JPEG mode)...");

  camOk = startCamera();      // even if this fails, WiFi + hub link still start so the dashboard shows why

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  if (camOk) startServers();

  char url[32];
  snprintf(url, sizeof(url), "/ws/%s", DEVICE_ID);
  ws.begin(HUB_HOST, HUB_PORT, url);
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(2000);
  ws.enableHeartbeat(10000, 3000, 2);

  Serial.println(camOk ? "[CAM] Camera OK, waiting for WiFi" : "[CAM] Camera NOT running, hub link only");
}

void loop() {
  wifiKeepAlive();
  if (WiFi.status() == WL_CONNECTED) ws.loop();
  sendHeartbeat();
  delay(5);
}
