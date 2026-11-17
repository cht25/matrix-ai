package ai.matrix.desktop

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class PopupArgs {
    var action: String = ""
}

@InvokeArg
class ToggleArgs {
    var enabled: Boolean = false
}

/**
 * Tauri plugin `qorvyna-assistant` — the Rust ⇄ Kotlin seam.
 *
 * `src-tauri/src/assistant.rs` registers `ai.matrix.desktop.AssistantPlugin`
 * and calls three commands:
 *
 *   `state` → what the device really has: overlay grant, enrolled wake model,
 *             digital-assistant role, bubble/service running, template count;
 *   `popup` → `show` | `hide` | `toggle` | `state` | `pending` | `enroll` |
 *             `clear` | `overlay-settings` | `assistant-settings`;
 *   `wake`  → turn the on-device wake phrase on/off and return fresh state.
 *
 * Every answer is read from the platform at call time. If this class is absent
 * from the generated Android project (project generated before this feature),
 * Rust reports ASSISTANT_UNAVAILABLE — no more `shown: false` pretending.
 */
@TauriPlugin
class AssistantPlugin(private val activity: Activity) : Plugin(activity) {

    init {
        // Restore the bubble + wake listener after a process restart, but only
        // when the user actually enrolled a phrase and left it enabled.
        val context = activity.applicationContext
        if (QorvynaAssistantService.isWakeEnabled(context) &&
            QorvynaAssistantService.wakeWordReady(context)
        ) {
            QorvynaAssistantService.requestStart(context)
        }
    }

    private fun stateObject(): JSObject {
        val context = activity.applicationContext
        val engine = QorvynaWakeWord(context)
        val overlay = QorvynaAssistantService.canDrawOverlays(context)
        val ready = engine.isReady()
        val defaultAssistant = QorvynaAssistantService.isDefaultAssistant(context)
        val templates = engine.templateCount()
        val detail = when {
            !overlay && !ready ->
                "Grant “Display over other apps” and enrol the wake phrase " +
                    "to get the floating bubble and hands-free use."
            !overlay ->
                "Grant “Display over other apps” so the floating bubble can sit over other apps."
            !ready ->
                "Wake phrase not enrolled yet: record it ${QorvynaWakeWord.MIN_TEMPLATES} times " +
                    "in QORVYNA settings to use “Hey QORVYNA”."
            !defaultAssistant ->
                "Bubble and wake phrase are ready. Set QORVYNA as the digital assistant " +
                    "for the system gesture."
            else -> "Bubble, wake phrase and digital-assistant role are all active."
        }
        return JSObject().apply {
            put("overlayGranted", overlay)
            put("wakeWordReady", ready)
            put("wakeWordEnabled", QorvynaAssistantService.isWakeEnabled(context))
            put("defaultAssistant", defaultAssistant)
            put("bubbleRunning", QorvynaAssistantService.isRunning())
            put("templates", templates)
            put("requiredTemplates", QorvynaWakeWord.MIN_TEMPLATES)
            put("threshold", engine.threshold())
            put("detail", detail)
        }
    }

    @Command
    fun state(invoke: Invoke) {
        invoke.resolve(stateObject())
    }

    @Command
    fun popup(invoke: Invoke) {
        val args = invoke.parseArgs(PopupArgs::class.java)
        val context = activity.applicationContext
        when (args.action) {
            "show" -> {
                QorvynaAssistantService.requestStart(context)
                openApp("show")
                invoke.resolve(shown(true))
            }
            "hide" -> {
                QorvynaAssistantService.requestStop(context)
                invoke.resolve(shown(false))
            }
            "toggle" -> {
                if (QorvynaAssistantService.isRunning()) {
                    QorvynaAssistantService.requestStop(context)
                    invoke.resolve(shown(false))
                } else {
                    QorvynaAssistantService.requestStart(context)
                    openApp("show")
                    invoke.resolve(shown(true))
                }
            }
            "state" -> invoke.resolve(shown(QorvynaAssistantService.isRunning()))
            "pending" -> invoke.resolve(JSObject().put("pending", QorvynaAssistantService.takePending(context)))
            "enroll" -> {
                QorvynaAssistantService.requestStart(context)
                QorvynaAssistantService.enrolOnce(context) { templates, detail ->
                    val payload = buildState()
                    payload.put("templates", templates)
                    payload.put("detail", detail)
                    invoke.resolve(payload)
                }
            }
            "clear" -> {
                QorvynaAssistantService.clearTemplates(context)
                val payload = buildState()
                payload.put("detail", "Enrolled wake-phrase samples deleted from this device.")
                invoke.resolve(payload)
            }
            "overlay-settings" -> {
                context.startActivity(
                    Intent(
                        Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:${context.packageName}"),
                    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
                invoke.resolve(
                    JSObject().put("opened", true)
                        .put("detail", "Turn on “Allow display over other apps”, then come back."),
                )
            }
            "assistant-settings" -> {
                context.startActivity(
                    Intent(Settings.ACTION_VOICE_INPUT_SETTINGS)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
                invoke.resolve(
                    JSObject().put("opened", true)
                        .put("detail", "Choose QORVYNA as the digital assistant."),
                )
            }
            else -> invoke.reject("UNKNOWN_ACTION: ${args.action}")
        }
    }

    @Command
    fun wake(invoke: Invoke) {
        val args = invoke.parseArgs(ToggleArgs::class.java)
        val context = activity.applicationContext
        QorvynaAssistantService.setWakeEnabled(context, args.enabled)
        if (args.enabled) {
            QorvynaAssistantService.requestStart(context)
            if (!QorvynaAssistantService.wakeWordReady(context)) {
                invoke.resolve(
                    stateObject().put(
                        "detail",
                        "Record the wake phrase ${QorvynaWakeWord.MIN_TEMPLATES} times before " +
                            "“Hey QORVYNA” can work — nothing is listening yet.",
                    ),
                )
                return
            }
        }
        invoke.resolve(stateObject())
    }

    /** Fresh state read; used after mutating calls so the UI never guesses. */
    private fun buildState(): JSObject = stateObject()

    private fun shown(visible: Boolean): JSObject = JSObject().apply {
        put("shown", visible)
        put("window", "assistant")
        put("platform", "android")
        put("detail", if (visible) "Floating assistant is on screen." else "Floating assistant is hidden.")
    }

    private fun openApp(source: String) {
        try {
            activity.startActivity(
                Intent(activity, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    .putExtra(QorvynaAssistantService.EXTRA_SOURCE, source)
                    .setData(Uri.parse("qorvyna://assistant?source=$source")),
            )
        } catch (_: Throwable) {
            // The launcher icon still opens the app.
        }
    }
}
