#!/usr/bin/env node
/**
 * Finish the Android project that `tauri android init` generates.
 *
 * `src-tauri/gen/android` is generated, so it is never hand-edited: this script
 * is idempotent and runs after init (`npm run android:init` chains it), or on
 * its own via `npm run android:manifest`.
 *
 * It does three things, each verified before writing:
 *
 *   1. copies every Kotlin source from `src-tauri/android/.../kotlin/` into the
 *      generated app module, so the notification listener AND the assistant
 *      plugin/service/activity are actually compiled into the APK;
 *   2. declares what those classes need in `AndroidManifest.xml`:
 *        • the notification-listener binding permission and service;
 *        • the floating-assistant foreground service (microphone type);
 *        • the `ASSIST` activity that gives QORVYNA the digital-assistant role;
 *        • `SYSTEM_ALERT_WINDOW`, `RECORD_AUDIO`, `FOREGROUND_SERVICE*`,
 *          `POST_NOTIFICATIONS` — declared, not granted: the user still has to
 *          allow each one, and the app reports the real state either way;
 *   3. prints exactly what changed so a build log never lies about it.
 *
 * It refuses to invent a project: without `tauri android init` it exits with a
 * clear message instead of creating a half-working tree.
 */
import { cp, mkdir, readdir, readFile, stat, writeFile, access } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const GEN = path.join(ROOT, "src-tauri/gen/android");
const MANIFEST = path.join(GEN, "app/src/main/AndroidManifest.xml");
const KOTLIN_SOURCE = path.join(ROOT, "src-tauri/android/app/src/main/kotlin");
const JAVA_TARGET = path.join(GEN, "app/src/main/java");

const NOTIFICATION_SERVICE = "ai.matrix.desktop.QorvynaNotificationListenerService";
const NOTIFICATION_PERMISSION = "android.permission.BIND_NOTIFICATION_LISTENER_SERVICE";
const ASSISTANT_SERVICE = "ai.matrix.desktop.QorvynaAssistantService";
const ASSIST_ACTIVITY = "ai.matrix.desktop.AssistActivity";

const NOTIFICATION_DECLARATION = `        <!-- QORVYNA notification forwarding. Requires explicit user enablement
             in system settings; declaring it grants no access on its own. -->
        <service
            android:name="${NOTIFICATION_SERVICE}"
            android:label="QORVYNA notification forwarding"
            android:exported="false"
            android:permission="${NOTIFICATION_PERMISSION}">
            <intent-filter>
                <action android:name="android.service.notification.NotificationListenerService" />
            </intent-filter>
        </service>`;

const ASSISTANT_DECLARATION = `        <!-- QORVYNA floating assistant: the bubble + on-device wake phrase.
             foregroundServiceType="microphone" is required from Android 14 for a
             service that records; nothing is recorded until the user enrols the
             wake phrase, and the audio never leaves the device. -->
        <service
            android:name="${ASSISTANT_SERVICE}"
            android:exported="false"
            android:foregroundServiceType="microphone" />
        <!-- Makes QORVYNA selectable under Settings → Apps → Default apps →
             Digital assistant. Exporting it is what the system needs to launch
             it; it forwards straight to the app and finishes. -->
        <activity
            android:name="${ASSIST_ACTIVITY}"
            android:exported="true"
            android:excludeFromRecents="true"
            android:launchMode="singleTask"
            android:theme="@android:style/Theme.Translucent.NoTitleBar">
            <intent-filter>
                <action android:name="android.intent.action.ASSIST" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
        </activity>`;

const PERMISSIONS = [
  "android.permission.SYSTEM_ALERT_WINDOW",
  "android.permission.RECORD_AUDIO",
  "android.permission.FOREGROUND_SERVICE",
  "android.permission.FOREGROUND_SERVICE_MICROPHONE",
  "android.permission.POST_NOTIFICATIONS",
];

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** Copy the checked-in Kotlin sources into the generated app module. */
async function syncKotlin() {
  if (!(await exists(KOTLIN_SOURCE))) {
    console.log("[android] No Kotlin sources found — nothing to copy.");
    return [];
  }
  const copied = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const source = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(source);
        continue;
      }
      if (!entry.name.endsWith(".kt")) continue;
      const relative = path.relative(KOTLIN_SOURCE, source);
      const target = path.join(JAVA_TARGET, relative);
      await mkdir(path.dirname(target), { recursive: true });
      const same =
        (await exists(target)) &&
        (await readFile(target, "utf8")) === (await readFile(source, "utf8"));
      if (same) continue;
      await cp(source, target);
      copied.push(relative);
    }
  };
  await walk(KOTLIN_SOURCE);
  if (copied.length === 0) console.log("[android] Kotlin sources already up to date.");
  else for (const file of copied) console.log(`[android] Copied ${file}`);
  return copied;
}

/** Add <uses-permission> entries that are missing, in declaration order. */
function declarePermissions(manifest) {
  const missing = PERMISSIONS.filter(
    (permission) => !manifest.includes(`android:name="${permission}"`),
  );
  if (missing.length === 0) return { manifest, added: [] };
  const application = /^[ \t]*<application/m.exec(manifest);
  if (!application) throw new Error("[android] Manifest has no <application> element; refusing to guess.");
  const block = missing.map((permission) => `    <uses-permission android:name="${permission}" />\n`).join("");
  return {
    manifest: `${manifest.slice(0, application.index)}${block}${manifest.slice(application.index)}`,
    added: missing,
  };
}

/** Insert one <application> child if its android:name is absent. */
function insertComponent(manifest, name, block) {
  if (manifest.includes(`android:name="${name}"`)) return { manifest, changed: false };
  if (!manifest.includes("</application>")) {
    throw new Error("[android] Manifest has no </application> element; refusing to guess.");
  }
  return {
    manifest: manifest.replace("</application>", `${block}\n    </application>`),
    changed: true,
  };
}

async function main() {
  if (!(await exists(MANIFEST))) {
    console.error(
      `[android] No Android project found at ${MANIFEST}.\n` +
        "[android] Run `npm run android:init` (tauri android init) first — this script never invents a project.",
    );
    process.exit(1);
  }

  const copied = await syncKotlin();

  const original = await readFile(MANIFEST, "utf8");
  const permissions = declarePermissions(original);
  let manifest = permissions.manifest;

  const notification = insertComponent(manifest, NOTIFICATION_SERVICE, NOTIFICATION_DECLARATION);
  manifest = notification.manifest;
  const assistant = insertComponent(manifest, ASSISTANT_SERVICE, ASSISTANT_DECLARATION);
  manifest = assistant.manifest;

  const changed =
    copied.length > 0 ||
    permissions.added.length > 0 ||
    notification.changed ||
    assistant.changed;

  if (!changed) {
    console.log(
      "[android] Notification listener, assistant service/activity and Kotlin sources are " +
        "already declared — nothing to do.",
    );
  } else {
    await writeFile(MANIFEST, manifest, "utf8");
    for (const permission of permissions.added) console.log(`[android] Declared ${permission}`);
    if (notification.changed) console.log("[android] Declared QorvynaNotificationListenerService.");
    if (assistant.changed) {
      console.log("[android] Declared QorvynaAssistantService and AssistActivity (ASSIST role).");
    }
  }

  console.log(
    "[android] Still manual, by design: allow notification access, allow “Display over other apps”, " +
      "record the wake phrase, and pick QORVYNA as the digital assistant.",
  );
}

main().catch(async (error) => {
  console.error("[android] Failed:", error?.message ?? error);
  // Keep a clear failure for the build log instead of a half-patched project.
  try {
    await stat(MANIFEST);
  } catch {
    console.error("[android] The manifest was not written.");
  }
  process.exit(1);
});
