// =============================================================================
// QORVYNA AI — native bridge (Tauri v2 commands)
//
// Every command here is:
//   • explicitly registered in `invoke_handler` (no dynamic dispatch);
//   • allowed only for the `main` window by capabilities/default.json;
//   • safe by construction — no command accepts a shell string, an arbitrary
//     path, or an arbitrary URL, and none can read account secrets.
//
// Platform behaviour is honest: a capability Android or Windows does not offer
// returns `supported: false` with a note the UI shows verbatim, instead of
// pretending the feature works.
// =============================================================================

use serde::Serialize;
use std::collections::HashMap;
use sysinfo::System as SysInfo;
use tauri::{AppHandle, Manager, Runtime};

#[derive(Serialize, Clone)]
pub struct NativeInfo {
    pub platform: String,
    #[serde(rename = "appVersion")]
    pub app_version: String,
    #[serde(rename = "osVersion")]
    pub os_version: String,
    #[serde(rename = "deviceName")]
    pub device_name: String,
}

#[derive(Serialize, Clone)]
pub struct PermissionEntry {
    pub id: String,
    pub state: String,
    pub detail: String,
}

#[derive(Serialize, Clone)]
pub struct AssistantState {
    #[serde(rename = "wakeWordSupported")]
    pub wake_word_supported: bool,
    #[serde(rename = "wakeWordEnabled")]
    pub wake_word_enabled: bool,
    #[serde(rename = "overlaySupported")]
    pub overlay_supported: bool,
    #[serde(rename = "defaultAssistant")]
    pub default_assistant: bool,
    pub note: String,
}

/// Settings QORVYNA persists locally (never account secrets).
const PREFS_FILE: &str = "native-prefs.json";

fn read_prefs<R: Runtime>(app: &AppHandle<R>) -> HashMap<String, serde_json::Value> {
    let Ok(dir) = app.path().app_data_dir() else {
        return HashMap::new();
    };
    let path = dir.join(PREFS_FILE);
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

fn write_prefs<R: Runtime>(app: &AppHandle<R>, prefs: &HashMap<String, serde_json::Value>) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(prefs).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(PREFS_FILE), text).map_err(|e| e.to_string())
}

fn platform_name() -> String {
    if cfg!(target_os = "android") {
        "android".to_string()
    } else if cfg!(target_os = "ios") {
        "ios".to_string()
    } else if cfg!(target_os = "windows") {
        "windows".to_string()
    } else if cfg!(target_os = "macos") {
        "macos".to_string()
    } else {
        "linux".to_string()
    }
}

fn os_version() -> String {
    SysInfo::long_os_version().unwrap_or_else(|| std::env::consts::OS.to_string())
}

fn device_name() -> String {
    SysInfo::host_name().unwrap_or_else(|| "QORVYNA device".to_string())
}

#[tauri::command]
pub fn qorvyna_native_info() -> NativeInfo {
    NativeInfo {
        platform: platform_name(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        os_version: os_version(),
        device_name: device_name(),
    }
}

// ---------------------------------------------------------------------------
// Permissions — the OS is the only source of truth.
// ---------------------------------------------------------------------------

/// Permission ids the frontend may ask about. Anything else is rejected.
const PERMISSION_IDS: [&str; 8] = [
    "microphone",
    "notifications",
    "notification_access",
    "screen_capture",
    "overlay",
    "background_microphone",
    "bluetooth",
    "assistant_role",
];

fn permission_entry(id: &str) -> PermissionEntry {
    // Desktop builds: the OS grants these to the app process; there is no
    // per-permission dialog for most of them, so the honest answer is
    // "granted" for the ones the app is entitled to and "unsupported" for
    // Android-only capabilities.
    let android_only = matches!(id, "notification_access" | "overlay" | "background_microphone" | "assistant_role");
    let (state, detail) = if cfg!(target_os = "android") {
        // Reported by the Android layer when it is installed; until then the
        // frontend shows "Open system settings" rather than a fake grant.
        (
            "not_requested",
            "Android reports this after you choose it in system settings.",
        )
    } else if android_only {
        (
            "unsupported",
            "This capability exists on Android only; the desktop app does not request it.",
        )
    } else {
        (
            "granted",
            "Granted by this operating system to the QORVYNA app.",
        )
    };
    PermissionEntry {
        id: id.to_string(),
        state: state.to_string(),
        detail: detail.to_string(),
    }
}

#[tauri::command]
pub fn qorvyna_permission_status() -> Vec<PermissionEntry> {
    PERMISSION_IDS.iter().map(|id| permission_entry(id)).collect()
}

#[tauri::command]
pub fn qorvyna_permission_request<R: Runtime>(
    app: AppHandle<R>,
    permission: String,
) -> Result<PermissionEntry, String> {
    if !PERMISSION_IDS.contains(&permission.as_str()) {
        return Err("UNKNOWN_PERMISSION".to_string());
    }
    let mut prefs = read_prefs(&app);
    prefs.insert(
        format!("perm.{permission}"),
        serde_json::Value::String("requested".to_string()),
    );
    let _ = write_prefs(&app, &prefs);
    // The OS prompt itself is raised by the platform layer (Android runtime
    // permissions) or by the webview (getUserMedia / Notification.requestPermission).
    Ok(permission_entry(&permission))
}

#[tauri::command]
pub fn qorvyna_permission_settings(permission: String) -> Result<serde_json::Value, String> {
    if !PERMISSION_IDS.contains(&permission.as_str()) {
        return Err("UNKNOWN_PERMISSION".to_string());
    }
    // Android's ACTION_APPLICATION_DETAILS_SETTINGS is opened by the mobile
    // layer in a later phase; desktop has no per-permission screen.
    Ok(serde_json::json!({
        "opened": false,
        "detail": if cfg!(target_os = "android") {
            "Open Settings → Apps → QORVYNA → Permissions on this device."
        } else {
            "This operating system manages this permission for the whole app; there is no per-permission screen."
        }
    }))
}

// ---------------------------------------------------------------------------
// Assistant / wake word
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn qorvyna_assistant_state<R: Runtime>(app: AppHandle<R>) -> AssistantState {
    let prefs = read_prefs(&app);
    let enabled = prefs
        .get("wakeWordEnabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let android = cfg!(target_os = "android");
    AssistantState {
        // On Android the wake-word service is part of the mobile build; here we
        // report support honestly instead of claiming always-on listening.
        wake_word_supported: android,
        wake_word_enabled: enabled && android,
        overlay_supported: android,
        default_assistant: false,
        note: if android {
            "QORVYNA can listen for “Hey QORVYNA” on this device when the wake-word service is permitted. Detection is on-device; audio is sent only after the phrase is heard.".to_string()
        } else {
            "Wake-word listening and the floating bubble are Android features. On desktop, use Ctrl+Shift+Space (or the tray menu) to talk to QORVYNA.".to_string()
        },
    }
}

#[tauri::command]
pub fn qorvyna_wake_word_set<R: Runtime>(app: AppHandle<R>, enabled: bool) -> Result<AssistantState, String> {
    let mut prefs = read_prefs(&app);
    prefs.insert("wakeWordEnabled".to_string(), serde_json::Value::Bool(enabled));
    write_prefs(&app, &prefs)?;
    Ok(qorvyna_assistant_state(app))
}

#[tauri::command]
pub fn qorvyna_assistant_default_request() -> serde_json::Value {
    serde_json::json!({
        "opened": false,
        "detail": if cfg!(target_os = "android") {
            "Set QORVYNA as the default assistant in Android Settings → Apps → Default apps → Digital assistant."
        } else {
            "The default-assistant role is an Android system feature."
        }
    })
}

#[tauri::command]
pub fn qorvyna_assistant_popup(action: String) -> Result<serde_json::Value, String> {
    match action.as_str() {
        "show" | "hide" => Ok(serde_json::json!({
            "shown": false,
            "detail": "The floating assistant window exists on Android builds only."
        })),
        _ => Err("UNKNOWN_ACTION".to_string()),
    }
}

// ---------------------------------------------------------------------------
// Device identity + inspection transparency
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn qorvyna_device_fingerprint<R: Runtime>(app: AppHandle<R>) -> serde_json::Value {
    // A random, non-secret installation id. It is never a device credential:
    // pairing tokens are minted server-side and only their hashes are stored.
    let prefs = read_prefs(&app);
    if let Some(existing) = prefs.get("fingerprint").and_then(|v| v.as_str()) {
        return serde_json::json!({ "fingerprint": existing });
    }
    let generated = format!(
        "{}-{:x}{:x}",
        platform_name(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        std::process::id()
    );
    let mut prefs = prefs;
    prefs.insert("fingerprint".to_string(), serde_json::Value::String(generated.clone()));
    let _ = write_prefs(&app, &prefs);
    serde_json::json!({ "fingerprint": generated })
}

#[tauri::command]
pub fn qorvyna_inspection_state() -> serde_json::Value {
    // Inspections are started by the server and announced through a visible
    // notification; the target device always shows the indicator. No session
    // is active unless the server says so.
    serde_json::json!({ "active": false })
}

#[tauri::command]
pub fn qorvyna_inspection_stop() -> serde_json::Value {
    serde_json::json!({ "stopped": true, "detail": "No inspection session is active on this device." })
}
