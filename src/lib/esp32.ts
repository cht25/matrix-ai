// =============================================================================
// MATRIX AI — ESP32 / hardware bridge domain (client-safe).
//
// An ESP32 (or any small microcontroller with Wi-Fi) can be a MATRIX node:
// a family check-in button, a screen-time traffic light, a "focus mode" lamp,
// a door/desk sensor, or an alarm that raises a MATRIX notification.
//
// SECURITY CONTRACT (enforced server-side, described here so firmware authors
// and the UI share one story):
//   · a device is registered with a one-time pairing code and receives a
//     scoped bearer credential — never a Firebase user token;
//   · the credential is stored hashed (SHA-256) and expires like a phone;
//   · every request is bounded: a 4 KB JSON body, a timestamp inside ±300s,
//     a monotonically increasing counter per device, and a replay cache;
//   · the device can only write its own readings and raise its own events —
//     it can never read family data or act as a user;
//   · the holder can revoke it from Devices at any time and the next request
//     fails immediately.
//
// This module is pure so firmware-facing schemas, the UI and tests agree.
// =============================================================================

export const ESP32_PROTOCOL_VERSION = "matrix-esp32:v1";

/** Board families the firmware bundle supports. */
export const ESP32_BOARDS = [
  { id: "esp32-devkit", label: "ESP32 DevKit (WROOM-32)", chip: "ESP32", gpio: 34 },
  { id: "esp32-s3", label: "ESP32-S3 DevKit", chip: "ESP32-S3", gpio: 48 },
  { id: "esp32-c3", label: "ESP32-C3 mini", chip: "ESP32-C3", gpio: 22 },
  { id: "esp8266", label: "ESP8266 / NodeMCU", chip: "ESP8266", gpio: 17 },
] as const;
export type Esp32BoardId = (typeof ESP32_BOARDS)[number]["id"];

/** Capabilities a node can declare; they decide which UI the device gets. */
export const ESP32_CAPABILITIES = [
  "check_in_button",
  "presence_sensor",
  "screen_time_lamp",
  "focus_mode",
  "sos_alarm",
  "display",
] as const;
export type Esp32Capability = (typeof ESP32_CAPABILITIES)[number];

export function isEsp32Capability(value: unknown): value is Esp32Capability {
  return typeof value === "string" && (ESP32_CAPABILITIES as readonly string[]).includes(value);
}

export function isEsp32Board(value: unknown): value is Esp32BoardId {
  return typeof value === "string" && ESP32_BOARDS.some((board) => board.id === value);
}

/** Maximum accepted telemetry payload (bytes) — firmware must stay tiny. */
export const ESP32_MAX_BODY_BYTES = 4096;
/** Clock skew allowed on signed readings. */
export const ESP32_MAX_SKEW_SECONDS = 300;
/** Readings older than this are stored but no longer drive "online". */
export const ESP32_ONLINE_WINDOW_MS = 1000 * 90;

export type Esp32Reading = {
  /** UNIX seconds reported by the device (validated against server clock). */
  ts: number;
  /** Monotonic per-device counter; replayed counters are rejected. */
  seq: number;
  /** Optional sensor values. Unknown keys are dropped server-side. */
  values?: Record<string, number | boolean | string>;
};

export type Esp32Event = {
  type: "check_in" | "sos" | "presence" | "focus_toggle" | "heartbeat";
  message?: string;
};

const EVENT_TYPES: readonly Esp32Event["type"][] = ["check_in", "sos", "presence", "focus_toggle", "heartbeat"];

export function isEsp32EventType(value: unknown): value is Esp32Event["type"] {
  return typeof value === "string" && (EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Pure validation shared by the API route and the test-suite.
 * Returns a machine code on failure — the route never echoes raw input back.
 */
export function validateEsp32Payload(input: unknown, nowSeconds: number): { ok: true; reading: Esp32Reading; event: Esp32Event | null } | { ok: false; code: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, code: "BODY_INVALID" };
  const body = input as Record<string, unknown>;
  if (body.v !== ESP32_PROTOCOL_VERSION) return { ok: false, code: "PROTOCOL_MISMATCH" };
  if (typeof body.device_id !== "string" || !/^[a-zA-Z0-9_-]{6,64}$/.test(body.device_id)) return { ok: false, code: "DEVICE_ID_INVALID" };
  const ts = Number(body.ts);
  if (!Number.isFinite(ts) || ts <= 0) return { ok: false, code: "TIMESTAMP_INVALID" };
  if (Math.abs(nowSeconds - ts) > ESP32_MAX_SKEW_SECONDS) return { ok: false, code: "CLOCK_SKEW" };
  const seq = Number(body.seq);
  if (!Number.isInteger(seq) || seq < 1 || seq > Number.MAX_SAFE_INTEGER) return { ok: false, code: "SEQUENCE_INVALID" };

  let values: Record<string, number | boolean | string> | undefined;
  if (body.values !== undefined) {
    if (!body.values || typeof body.values !== "object" || Array.isArray(body.values)) return { ok: false, code: "VALUES_INVALID" };
    const entries = Object.entries(body.values as Record<string, unknown>).slice(0, 24);
    values = {};
    for (const [key, value] of entries) {
      if (!/^[a-z][a-z0-9_]{0,31}$/.test(key)) continue;
      if (typeof value === "number" && Number.isFinite(value)) values[key] = value;
      else if (typeof value === "boolean") values[key] = value;
      else if (typeof value === "string" && value.length <= 80) values[key] = value;
    }
  }

  let event: Esp32Event | null = null;
  if (body.event !== undefined) {
    if (!body.event || typeof body.event !== "object" || Array.isArray(body.event)) return { ok: false, code: "EVENT_INVALID" };
    const raw = body.event as Record<string, unknown>;
    if (!isEsp32EventType(raw.type)) return { ok: false, code: "EVENT_INVALID" };
    event = {
      type: raw.type,
      ...(typeof raw.message === "string" && raw.message.trim() ? { message: raw.message.trim().slice(0, 160) } : {}),
    };
  }

  return { ok: true, reading: { ts, seq, values }, event };
}

/** Human label for a board/capability combination, used by the UI. */
export function esp32Summary(board: Esp32BoardId, capabilities: Esp32Capability[]): string {
  const label = ESP32_BOARDS.find((item) => item.id === board)?.label ?? "ESP32";
  if (!capabilities.length) return `${label} · no capabilities configured`;
  return `${label} · ${capabilities.length} capabilit${capabilities.length === 1 ? "y" : "ies"}`;
}

/**
 * Firmware the user can flash. It is intentionally dependency-light (Wi-Fi +
 * HTTPClient) so it compiles on a stock Arduino ESP32 core, and every pin,
 * endpoint and capability sits at the top as a constant.
 */
export function esp32FirmwareSource(input: {
  board: Esp32BoardId;
  capabilities: Esp32Capability[];
  endpoint: string;
  pairingCode: string;
  label: string;
  wifiSsid?: string;
  wifiPassword?: string;
}): string {
  const board = ESP32_BOARDS.find((item) => item.id === input.board) ?? ESP32_BOARDS[0];
  const has = (capability: Esp32Capability) => input.capabilities.includes(capability);
  const buttonPin = 4;
  const lampPin = 5;
  const sensorPin = 34;
  const safeLabel = input.label.replace(/[^a-zA-Z0-9 _.-]/g, "").slice(0, 48) || "MATRIX node";
  const ssid = (input.wifiSsid || "YOUR_WIFI_SSID").replace(/["\\]/g, "");
  const wifiPass = (input.wifiPassword || "YOUR_WIFI_PASSWORD").replace(/["\\]/g, "");
  const wantsButton = has("check_in_button") || has("sos_alarm");
  const wantsLamp = has("screen_time_lamp");
  const wantsSensor = has("presence_sensor");

  const buttonBlock = wantsButton
    ? `
// Hold this long for a check-in; twice as long raises SOS.
const unsigned long HOLD_MS = 700;
int lastButtonState = HIGH;
unsigned long pressedAt = 0;

void readButton() {
  int state = digitalRead(PIN_BUTTON);
  if (state == LOW && lastButtonState == HIGH) pressedAt = millis();
  if (state == HIGH && lastButtonState == LOW && pressedAt > 0) {
    unsigned long held = millis() - pressedAt;
    if (held >= HOLD_MS * 2) sendReading("sos", "SOS button held");
    else if (held >= HOLD_MS) sendReading("check_in", "Check-in button pressed");
    pressedAt = 0;
  }
  lastButtonState = state;
}
`
    : "";

  const lampBlock = wantsLamp
    ? `
// The server returns a lamp duty cycle (0-255) with every report.
void applyLamp(int level) { analogWrite(PIN_LAMP, constrain(level, 0, 255)); }
`
    : "";

  const lampParse = wantsLamp
    ? `
  int lampAt = response.indexOf("\\"lamp\\":");
  if (lampAt >= 0) applyLamp(response.substring(lampAt + 7).toInt());`
    : "";

  const valuesPart = wantsSensor
    ? `
  int presence = analogRead(PIN_SENSOR) > 1200 ? 1 : 0;
  body += ",\\"values\\":{\\"presence\\":";
  body += presence ? "true" : "false";
  body += "}";`
    : "";

  const buttonLoop = wantsButton ? `
  readButton();` : "";

  const pinSetup = wantsButton
    ? `
  pinMode(PIN_BUTTON, INPUT_PULLUP);`
    : "";

  return `// =============================================================================
// MATRIX node firmware — generated ${new Date().toISOString().slice(0, 10)}
// Board: ${board.label} (${board.chip})
// Node:  ${safeLabel}
//
// Flash with the Arduino IDE (ESP32 core) or arduino-cli. No extra libraries.
// The pairing code below is single use: the node exchanges it for a scoped
// device credential on first boot. Delete it from the source afterwards.
// =============================================================================
#include <WiFi.h>
#include <HTTPClient.h>

// --- configuration ----------------------------------------------------------
const char* WIFI_SSID       = "${ssid}";
const char* WIFI_PASSWORD   = "${wifiPass}";
const char* MATRIX_ENDPOINT = "${input.endpoint}";
const char* PAIRING_CODE    = "${input.pairingCode}";
const char* DEVICE_LABEL    = "${safeLabel}";
const char* PROTOCOL        = "${ESP32_PROTOCOL_VERSION}";

const int PIN_BUTTON = ${buttonPin};
const int PIN_LAMP   = ${lampPin};
const int PIN_SENSOR = ${sensorPin};
const unsigned long HEARTBEAT_MS = 30000;

String deviceId = "";
String deviceToken = "";
unsigned long seq = 1;
unsigned long lastBeat = 0;

void sendReading(const char* eventType, const char* message);
${lampBlock}${buttonBlock}
String jsonEscape(String value) {
  value.replace("\\\\", "\\\\\\\\");
  value.replace("\\"", "\\\\\\"");
  return value;
}

void sendReading(const char* eventType, const char* message) {
  String body = "{\\"v\\":\\"";
  body += PROTOCOL;
  body += "\\",\\"device_id\\":\\"";
  body += deviceId;
  body += "\\",\\"ts\\":";
  body += String((unsigned long)time(nullptr));
  body += ",\\"seq\\":";
  body += String(seq++);${valuesPart}
  if (eventType && strlen(eventType) > 0) {
    body += ",\\"event\\":{\\"type\\":\\"";
    body += eventType;
    body += "\\",\\"message\\":\\"";
    body += jsonEscape(String(message));
    body += "\\"}";
  }
  body += "}";

  HTTPClient http;
  http.begin(String(MATRIX_ENDPOINT) + "/api/devices/esp32/report");
  http.setTimeout(8000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + deviceToken);
  int code = http.POST(body);
  String response = http.getString();
  http.end();
  if (code < 200 || code >= 300) { Serial.println("report rejected"); return; }${lampParse}
}

bool pair() {
  HTTPClient http;
  http.begin(String(MATRIX_ENDPOINT) + "/api/devices/esp32/pair");
  http.setTimeout(8000);
  http.addHeader("Content-Type", "application/json");
  String body = "{\\"v\\":\\"";
  body += PROTOCOL;
  body += "\\",\\"code\\":\\"";
  body += PAIRING_CODE;
  body += "\\",\\"label\\":\\"";
  body += jsonEscape(DEVICE_LABEL);
  body += "\\",\\"board\\":\\"${board.id}\\"}";
  int code = http.POST(body);
  String response = http.getString();
  http.end();
  if (code < 200 || code >= 300) return false;
  int idAt = response.indexOf("\\"device_id\\":\\"");
  int tokAt = response.indexOf("\\"access_token\\":\\"");
  if (idAt < 0 || tokAt < 0) return false;
  idAt += 12; deviceId = response.substring(idAt, response.indexOf('"', idAt));
  tokAt += 16; deviceToken = response.substring(tokAt, response.indexOf('"', tokAt));
  return deviceId.length() > 0 && deviceToken.length() > 0;
}

void setup() {
  Serial.begin(115200);${pinSetup}
  pinMode(PIN_LAMP, OUTPUT);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) delay(250);
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  while (!pair()) { Serial.println("waiting to pair..."); delay(5000); }
  Serial.println("paired: " + deviceId);
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) { WiFi.reconnect(); delay(1000); return; }${buttonLoop}
  if (millis() - lastBeat > HEARTBEAT_MS) { lastBeat = millis(); sendReading("heartbeat", ""); }
  delay(50);
}
`;
}
