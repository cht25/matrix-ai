package ai.matrix.desktop

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle

/**
 * The assistant entry point on Android.
 *
 * Declared in the manifest with
 *
 *     <intent-filter>
 *         <action android:name="android.intent.action.ASSIST" />
 *         <category android:name="android.intent.category.DEFAULT" />
 *     </intent-filter>
 *
 * so once the user picks QORVYNA in Settings → Apps → Default apps → Digital
 * assistant, the system gesture (long-press home / power button, depending on
 * the device) lands here instead of the stock assistant.
 *
 * It is a transparent trampoline rather than a UI of its own: it marks a turn
 * as pending, starts the assistant service (bubble + wake word) and forwards
 * to the real app, which is the Tauri webview showing the assistant surface.
 * Finishing immediately means the user never sees an empty screen.
 */
class AssistActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val source = when (intent?.action) {
            Intent.ACTION_ASSIST -> "assist"
            else -> intent?.getStringExtra("qorvyna_assistant") ?: "assist"
        }
        try {
            QorvynaAssistantService.requestStart(this)
        } catch (_: Throwable) {
            // Foreground-service start can be refused in the background; the
            // launch below still opens the app, which starts the service.
        }
        val forward = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra("qorvyna_assistant", source)
            .setData(Uri.parse("qorvyna://assistant?source=$source"))
        try {
            startActivity(forward)
        } catch (_: Throwable) {
            // Nothing else to try: the launcher icon still works.
        }
        finish()
        // No transition animation: the system assistant should feel instant.
        overridePendingTransition(0, 0)
    }
}
