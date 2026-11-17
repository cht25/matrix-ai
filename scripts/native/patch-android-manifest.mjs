#!/usr/bin/env node
/**
 * Merge the QORVYNA notification-listener declaration into the Android
 * manifest that Tauri generates.
 *
 * Why a script: `src-tauri/gen/android` is produced by `tauri android init`
 * and is regenerated, so hand-editing it is lost. This runs after init (the
 * `android:init` npm script chains it) and is idempotent — running it twice
 * leaves exactly one declaration.
 *
 * It refuses to invent a manifest: if `tauri android init` has not run, it
 * exits with a clear message instead of creating a half-project.
 */
import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const MANIFEST = path.join(ROOT, "src-tauri/gen/android/app/src/main/AndroidManifest.xml");
const SERVICE = "ai.matrix.desktop.QorvynaNotificationListenerService";
const PERMISSION = "android.permission.BIND_NOTIFICATION_LISTENER_SERVICE";

const DECLARATION = `
        <!-- QORVYNA notification forwarding. Requires explicit user enablement
             in system settings; declaring it grants no access on its own. -->
        <service
            android:name="${SERVICE}"
            android:label="QORVYNA notification forwarding"
            android:exported="false"
            android:permission="${PERMISSION}">
            <intent-filter>
                <action android:name="android.service.notification.NotificationListenerService" />
            </intent-filter>
        </service>`;

async function main() {
  try {
    await access(MANIFEST);
  } catch {
    console.error(
      `[android] No Android project found at ${MANIFEST}.\n` +
        `[android] Run \`npm run android:init\` (tauri android init) first — this script never invents a project.`,
    );
    process.exit(1);
  }

  const original = await readFile(MANIFEST, "utf8");
  if (original.includes(SERVICE)) {
    console.log("[android] Notification listener already declared — nothing to do.");
    return;
  }
  if (!original.includes("</application>")) {
    console.error("[android] Manifest has no </application> element; refusing to guess.");
    process.exit(1);
  }

  const patched = original.replace("</application>", `${DECLARATION}\n    </application>`);
  await writeFile(MANIFEST, patched, "utf8");
  console.log("[android] Declared QorvynaNotificationListenerService.");
  console.log("[android] Users must still enable notification access in system settings.");
}

main().catch((error) => {
  console.error("[android] Failed:", error);
  process.exit(1);
});
