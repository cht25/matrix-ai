// =============================================================================
// QORVYNA — floating assistant (the "popup" surface)
//
// One assistant, two hosts, both real:
//
//   DESKTOP (Windows/macOS/Linux)
//     A second Tauri window labelled `assistant`: frameless, always-on-top,
//     skipped from the taskbar, 400×540. It loads the SAME bundled frontend
//     (`index.html?window=assistant` → src/native/assistant-popup.tsx), so the
//     popup is the existing app's UI, not a second application. `Ctrl+Shift+
//     Space` toggles it; the window is created lazily and then reused.
//
//   ANDROID
//     The floating bubble + wake-word foreground service live in Kotlin
//     (src-tauri/android/.../QorvynaAssistantService.kt). Rust reaches them
//     through a Tauri mobile plugin named `qorvyna-assistant`; the Kotlin side
//     is `ai.matrix.desktop.AssistantPlugin`. If the plugin is not attached
//     (for example an Android project generated before this feature), every
//     call returns ASSISTANT_UNAVAILABLE instead of pretending to work.
//
// Nothing here invents state: `assistant_state` reports what the platform and
// the Kotlin service actually report, and "wake word" is only ever reported as
// supported when a real on-device model is present.
// =============================================================================

use serde_json::{json, Value};
#[cfg(desktop)]
use tauri::Emitter;
use tauri::AppHandle;

/// Label of the desktop popup window. Also listed in capabilities/default.json.
pub const ASSISTANT_WINDOW: &str = "assistant";

/// Route the popup window loads: the bundled frontend, popup variant.
pub const ASSISTANT_URL: &str = "index.html?window=assistant";

// ---------------------------------------------------------------------------
// Desktop window
// ---------------------------------------------------------------------------

#[cfg(desktop)]
fn desktop_window<R: tauri::Runtime>(
    app: &AppHandle<R>,
) -> Result<tauri::WebviewWindow<R>, String> {
    if let Some(existing) = app.get_webview_window(ASSISTANT_WINDOW) {
        return Ok(existing);
    }
    tauri::WebviewWindowBuilder::new(
        app,
        ASSISTANT_WINDOW,
        tauri::WebviewUrl::App(ASSISTANT_URL.into()),
    )
    .title("QORVYNA Assistant")
    .inner_size(400.0, 540.0)
    .min_inner_size(320.0, 420.0)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(true)
    .visible(false)
    .focused(false)
    .center()
    .build()
    .map_err(|error| format!("ASSISTANT_WINDOW_FAILED: {error}"))
}

#[cfg(desktop)]
fn desktop_popup<R: tauri::Runtime>(app: &AppHandle<R>, action: &str) -> Result<Value, String> {
    let window = desktop_window(app)?;
    let visible = window.is_visible().unwrap_or(false);
    let show = match action {
        "show" => true,
        "hide" => false,
        "toggle" => !visible,
        "state" => visible,
        other => return Err(format!("UNKNOWN_ACTION: {other}")),
    };
    if action != "state" {
        if show {
            window.show().map_err(|error| error.to_string())?;
            let _ = window.set_focus();
            // The popup starts listening as soon as it is visible.
            let _ = window.emit("qorvyna://voice-activate", ());
        } else {
            window.hide().map_err(|error| error.to_string())?;
        }
    }
    Ok(json!({
        "shown": show,
        "window": ASSISTANT_WINDOW,
        "platform": "desktop",
        "detail": if show { "Floating assistant is on screen." } else { "Floating assistant is hidden." },
    }))
}

/// Show, hide or toggle the floating assistant. `action` is one of
/// `show` | `hide` | `toggle` | `state`.
pub fn popup<R: tauri::Runtime>(app: &AppHandle<R>, action: &str) -> Result<Value, String> {
    #[cfg(desktop)]
    {
        let _ = app;
        return desktop_popup(app, action);
    }
    #[cfg(mobile)]
    {
        let _ = app;
        return mobile_call("popup", json!({ "action": action }));
    }
    #[allow(unreachable_code)]
    Err("UNSUPPORTED_PLATFORM".to_string())
}

/// Bring the full app forward and dismiss the popup (used by the popup's
/// "Open QORVYNA" button and by the tray menu).
pub fn open_main<R: tauri::Runtime>(app: &AppHandle<R>) -> Value {
    #[cfg(desktop)]
    {
        if let Some(popup_window) = app.get_webview_window(ASSISTANT_WINDOW) {
            let _ = popup_window.hide();
        }
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.show();
            let _ = main.set_focus();
            return json!({ "opened": true });
        }
        json!({ "opened": false, "detail": "The main window is not available." })
    }
    #[cfg(mobile)]
    {
        let _ = app;
        json!({ "opened": false, "detail": "The main screen is already in the foreground on this platform." })
    }
    #[allow(unreachable_code)]
    json!({ "opened": false })
}

/// Toggle from the global shortcut / tray. Never panics if the window cannot
/// be created (for example a headless session): the caller falls back to the
/// main window.
pub fn toggle_or_null<R: tauri::Runtime>(app: &AppHandle<R>) -> bool {
    #[cfg(desktop)]
    {
        return popup(app, "toggle")
            .map(|value| value.get("shown").and_then(Value::as_bool).unwrap_or(false))
            .unwrap_or(false);
    }
    #[cfg(mobile)]
    {
        let _ = app;
        false
    }
    #[allow(unreachable_code)]
    false
}

// ---------------------------------------------------------------------------
// Android bridge (Kotlin: QorvynaAssistantService + AssistantPlugin)
// ---------------------------------------------------------------------------

#[cfg(target_os = "android")]
static MOBILE_PLUGIN: std::sync::Mutex<Option<tauri::plugin::PluginHandle<tauri::Wry>>> =
    std::sync::Mutex::new(None);

#[cfg(mobile)]
fn mobile_call(command: &str, payload: Value) -> Result<Value, String> {
    #[cfg(target_os = "android")]
    {
        let guard = MOBILE_PLUGIN
            .lock()
            .map_err(|_| "ASSISTANT_UNAVAILABLE".to_string())?;
        let handle = guard.as_ref().ok_or_else(|| {
            "ASSISTANT_UNAVAILABLE: the Android assistant plugin is not attached. Re-run \
             `npm run android:init` so the generated project includes AssistantPlugin."
                .to_string()
        })?;
        let response: Value = handle
            .run_mobile_plugin(command, payload)
            .map_err(|error| format!("ASSISTANT_CALL_FAILED: {error}"))?;
        Ok(response)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (command, payload);
        Err("UNSUPPORTED_PLATFORM".to_string())
    }
}

/// Consume the "turn requested while the UI was away" flag. Desktop has no
/// background assistant, so it is always false there.
pub fn take_pending() -> bool {
    #[cfg(mobile)]
    {
        return mobile_call("pending", json!({}))
            .ok()
            .and_then(|value| value.get("pending").and_then(Value::as_bool))
            .unwrap_or(false);
    }
    #[allow(unreachable_code)]
    false
}

/// Persist the wake-phrase preference in the Kotlin service that owns the mic.
pub fn set_wake_word(enabled: bool) -> Result<Value, String> {
    #[cfg(mobile)]
    {
        return mobile_call("wake", json!({ "enabled": enabled }));
    }
    #[allow(unreachable_code)]
    {
        let _ = enabled;
        Ok(json!({ "supported": false }))
    }
}

/// Record one wake-phrase sample (Android only; ~3 s of audio).
pub fn enrol_wake_word() -> Result<Value, String> {
    #[cfg(mobile)]
    {
        return mobile_call("popup", json!({ "action": "enroll" }));
    }
    #[allow(unreachable_code)]
    Err("UNSUPPORTED_PLATFORM: wake-phrase enrolment is Android only.".to_string())
}

/// Forget every enrolled wake-phrase sample (Android only).
pub fn clear_wake_word() -> Result<Value, String> {
    #[cfg(mobile)]
    {
        return mobile_call("popup", json!({ "action": "clear" }));
    }
    #[allow(unreachable_code)]
    Err("UNSUPPORTED_PLATFORM: wake-phrase samples only exist on Android.".to_string())
}

/// Ask the OS to show the overlay / digital-assistant settings (Android only).
pub fn open_assistant_settings(which: &str) -> Result<Value, String> {
    #[cfg(mobile)]
    {
        let action = match which {
            "overlay" => "overlay-settings",
            _ => "assistant-settings",
        };
        return mobile_call("popup", json!({ "action": action }));
    }
    #[allow(unreachable_code)]
    {
        let _ = which;
        Err("UNSUPPORTED_PLATFORM: these settings are Android only.".to_string())
    }
}

/// Ask the Android service what it can really do right now.
pub fn mobile_state() -> Option<Value> {
    #[cfg(target_os = "android")]
    {
        return mobile_call("state", json!({})).ok();
    }
    #[allow(unreachable_code)]
    None
}

/// The Tauri plugin that exposes Kotlin `AssistantPlugin` to Rust.
///
/// Desktop builds register an empty plugin (it costs nothing); Android builds
/// attach the Kotlin class during setup. The Kotlin class is copied into the
/// generated project by scripts/native/patch-android-manifest.mjs.
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    let builder = tauri::plugin::Builder::new("qorvyna-assistant");

    #[cfg(target_os = "android")]
    let builder = builder.setup(|_app, api| {
        match api.register_android_plugin("ai.matrix.desktop", "AssistantPlugin") {
            Ok(handle) => {
                if let Ok(mut slot) = MOBILE_PLUGIN.lock() {
                    *slot = Some(handle);
                }
            }
            Err(error) => {
                // Not fatal: the rest of the app works, and every assistant
                // call reports ASSISTANT_UNAVAILABLE with this reason.
                eprintln!("[QORVYNA] Android assistant plugin not attached: {error}");
            }
        }
        Ok(())
    });

    builder.build()
}
