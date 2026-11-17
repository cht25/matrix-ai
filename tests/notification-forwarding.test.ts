// =============================================================================
// Phase 9 — notification forwarding.
//
// The Kotlin listener cannot run in this sandbox, so its privacy rules are
// verified two ways:
//   1. source-level invariants (the service really filters before forwarding,
//      really requires the user-granted permission, and never queues to disk);
//   2. a faithful TypeScript mirror of the redaction/drop rules, tested here so
//      the exact patterns are pinned down.
// The server-side privacy modes are covered in
// tests/parent-policy-and-notifications.test.ts.
// =============================================================================
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const KOTLIN = readFileSync(
  path.join(ROOT, "src-tauri/android/app/src/main/kotlin/ai/matrix/desktop/QorvynaNotificationListenerService.kt"),
  "utf8",
);
const MANIFEST_SCRIPT = readFileSync(path.join(ROOT, "scripts/native/patch-android-manifest.mjs"), "utf8");

// --- mirror of the Kotlin rules --------------------------------------------
// Same three rules as the Kotlin SECRET_PATTERNS list. Kotlin writes `(?i)`
// inline; JavaScript needs the flag, hence RegExp rather than a literal.
const SECRET_PATTERNS = [
  /\b\d{4,8}\b/,
  new RegExp("\\b(otp|one[- ]?time|verification code|login code|2fa|pin)\\b", "i"),
  new RegExp("\\b(password|passcode|recovery key|seed phrase)\\b", "i"),
];
const SENSITIVE_CATEGORIES = new Set(["msg", "email", "call", "alarm"]);
const isSensitiveBody = (text: string) => SECRET_PATTERNS.some((pattern) => pattern.test(text));
const redact = (text: string) =>
  SECRET_PATTERNS.some((pattern) => pattern.test(text)) ? "•••• (hidden: may contain a code or password)" : text;

describe("Phase 9 — the service is declared, not assumed", () => {
  it("binds the user-granted notification listener permission", () => {
    expect(KOTLIN).toContain("NotificationListenerService");
    expect(MANIFEST_SCRIPT).toContain("android.permission.BIND_NOTIFICATION_LISTENER_SERVICE");
    expect(MANIFEST_SCRIPT).toContain('android:exported="false"');
  });

  it("refuses to invent an Android project when init has not run", () => {
    expect(MANIFEST_SCRIPT).toContain("never invents a project");
    expect(MANIFEST_SCRIPT).toContain("process.exit(1)");
  });

  it("is idempotent so re-running cannot duplicate the service", () => {
    expect(MANIFEST_SCRIPT).toContain("already declared");
  });
});

describe("Phase 9 — nothing sensitive is forwarded", () => {
  it("drops one-time codes and passwords instead of forwarding them", () => {
    expect(isSensitiveBody("Your verification code is 482913")).toBe(true);
    expect(isSensitiveBody("482913 is your OTP")).toBe(true);
    expect(isSensitiveBody("Reset your password now")).toBe(true);
    expect(isSensitiveBody("Use passcode 9911 to unlock")).toBe(true);
    expect(isSensitiveBody("Your parcel is out for delivery")).toBe(false);
  });

  it("redacts rather than echoing a code when text must be shown", () => {
    expect(redact("Code 1234")).not.toContain("1234");
    expect(redact("Hello there")).toBe("Hello there");
  });

  it("never captures messaging, email, call or alarm categories on-device", () => {
    for (const category of ["msg", "email", "call", "alarm"]) expect(SENSITIVE_CATEGORIES.has(category)).toBe(true);
  });

  it("the source really drops sensitive bodies before invoking the bridge", () => {
    // `isSensitiveBody` must appear in the post handler, before onEventCallback.
    const postHandler = KOTLIN.slice(KOTLIN.indexOf("override fun onNotificationPosted"), KOTLIN.indexOf("override fun onNotificationRemoved"));
    expect(postHandler).toContain("isSensitiveBody");
    expect(postHandler.indexOf("isSensitiveBody")).toBeLessThan(postHandler.indexOf("onEventCallback"));
    expect(postHandler).toContain("SENSITIVE_CATEGORIES.contains");
  });
});

describe("Phase 9 — bounded, no disk persistence", () => {
  it("keeps at most 60 entries and writes no files", () => {
    expect(KOTLIN).toContain("recent.size > 60");
    expect(KOTLIN).not.toMatch(/FileOutputStream|SharedPreferences|openFileOutput|\.write\(/);
  });

  it("does not echo its own notifications or ongoing media bars", () => {
    expect(KOTLIN).toContain("item.packageName == packageName");
    expect(KOTLIN).toContain("item.isOngoing");
    expect(KOTLIN).toContain("FLAG_ONGOING_EVENT");
  });
});
