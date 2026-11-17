// =============================================================================
// QORVYNA AI — Tauri v2 Desktop & Companion Core
//
// Exposes:
//   1. `matrix_notify(title, body)` — native OS notifications.
//   2. `matrix_collect_device_activity()` — opt-in companion telemetry.
//   3. `qorvyna_desktop_info()` & `desktop_hardware_status()` — real system telemetry.
//   4. `launch_app(app_name)` — allowlisted app launcher (no arbitrary shell exec).
//   5. `media_control(action)` — OS media/volume control on Windows.
//   6. Global hotkey `CmdOrCtrl+Shift+Space` + system tray voice activation
//      emitting `qorvyna://voice-activate` to the web UI.
// =============================================================================

use chrono::Utc;
use serde::Serialize;
use std::collections::HashMap;
use std::process::Command;
use sysinfo::{ProcessesToUpdate, System};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, ShortcutState};
use tauri_plugin_notification::NotificationExt;

mod native;

#[derive(Serialize)]
pub struct CompanionAppUsage {
    pub name: String,
    pub package: String,
    pub minutes: u64,
    pub hidden: bool,
    pub last_used: String,
}

#[derive(Serialize)]
pub struct CompanionBrowserVisit {
    pub url: String,
    pub title: String,
    pub visited_at: String,
}

#[derive(Serialize)]
pub struct CompanionActivityPayload {
    pub device_id: String,
    pub device_name: String,
    pub platform: String,
    pub screen_time_minutes: u64,
    pub apps: Vec<CompanionAppUsage>,
    pub hidden_apps: Vec<CompanionAppUsage>,
    pub browser_history: Vec<CompanionBrowserVisit>,
}

#[derive(Serialize)]
pub struct DesktopAppInfo {
    pub app_name: String,
    pub version: String,
    pub platform: String,
    pub chat_url: String,
    pub global_hotkey: String,
}

#[derive(Serialize)]
pub struct DesktopActionOutcome {
    pub ok: bool,
    pub status: String,
    pub message: String,
}

#[derive(Serialize)]
pub struct DesktopHardwareStatus {
    pub host_name: String,
    pub os_name: String,
    pub uptime_minutes: u64,
    pub total_memory_mb: u64,
    pub used_memory_mb: u64,
    pub cpu_count: usize,
}

#[tauri::command]
fn qorvyna_desktop_info() -> DesktopAppInfo {
    DesktopAppInfo {
        app_name: "QORVYNA AI".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        chat_url: "https://qorvyna.thamjj13.top/chat".to_string(),
        global_hotkey: "Ctrl+Shift+Space".to_string(),
    }
}

#[tauri::command]
fn desktop_hardware_status() -> DesktopHardwareStatus {
    let mut sys = System::new_all();
    sys.refresh_memory();
    DesktopHardwareStatus {
        host_name: System::host_name().unwrap_or_else(|| "QORVYNA-Desktop".to_string()),
        os_name: System::long_os_version().unwrap_or_else(|| std::env::consts::OS.to_string()),
        uptime_minutes: (System::uptime() / 60),
        total_memory_mb: sys.total_memory() / (1024 * 1024),
        used_memory_mb: sys.used_memory() / (1024 * 1024),
        cpu_count: sys.cpus().len(),
    }
}

/// Safe allowlisted app launcher: never invokes arbitrary user shell strings.
#[tauri::command]
fn launch_app(app_name: String) -> DesktopActionOutcome {
    let normalized = app_name.trim().to_lowercase();
    let target: Option<&str> = match normalized.as_str() {
        "notepad" => Some("notepad.exe"),
        "calculator" | "calc" => Some("calc.exe"),
        "paint" | "mspaint" => Some("mspaint.exe"),
        "explorer" | "file explorer" | "files" => Some("explorer.exe"),
        "terminal" | "cmd" => Some("cmd.exe"),
        "powershell" => Some("powershell.exe"),
        "chrome" | "google chrome" => Some("chrome.exe"),
        "edge" | "microsoft edge" => Some("msedge.exe"),
        "vscode" | "vs code" | "code" => Some("code.cmd"),
        "spotify" => Some("spotify.exe"),
        "settings" | "windows settings" => Some("ms-settings:"),
        _ => None,
    };

    let Some(exe) = target else {
        return DesktopActionOutcome {
            ok: false,
            status: "not_allowed".to_string(),
            message: format!(
                "\"{}\" is not in the desktop safe-launch allowlist (notepad, calculator, explorer, terminal, chrome, edge, vscode, spotify, settings).",
                app_name.trim()
            ),
        };
    };

    #[cfg(target_os = "windows")]
    {
        let spawned = if exe.ends_with(':') {
            Command::new("cmd").args(["/C", "start", "", exe]).spawn()
        } else {
            Command::new("cmd").args(["/C", "start", "", exe]).spawn()
        };
        return match spawned {
            Ok(_) => DesktopActionOutcome {
                ok: true,
                status: "executed".to_string(),
                message: format!("Launched {} on Windows Desktop.", app_name.trim()),
            },
            Err(err) => DesktopActionOutcome {
                ok: false,
                status: "failed".to_string(),
                message: format!("Could not launch {}: {}", app_name.trim(), err),
            },
        };
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = exe;
        DesktopActionOutcome {
            ok: false,
            status: "not_supported".to_string(),
            message: "Desktop app launch allowlist currently targets Windows Desktop hosts.".to_string(),
        }
    }
}

#[tauri::command]
fn media_control(action: String) -> DesktopActionOutcome {
    let key_code: Option<(u8, &str)> = match action.trim().to_lowercase().as_str() {
        "play_pause" | "pause" | "play" => Some((0xB3, "play/pause")),
        "next" => Some((0xB0, "next track")),
        "previous" | "prev" => Some((0xB1, "previous track")),
        "volume_down" => Some((0xAE, "volume down")),
        "volume_up" => Some((0xAF, "volume up")),
        "mute" => Some((0xAD, "mute")),
        _ => None,
    };

    let Some((vk, label)) = key_code else {
        return DesktopActionOutcome {
            ok: false,
            status: "not_supported".to_string(),
            message: format!("Unsupported media action: {}", action),
        };
    };

    #[cfg(target_os = "windows")]
    {
        let script = format!(
            "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class K {{ [DllImport(\"user32.dll\")] public static extern void keybd_event(byte vk, byte scan, int flags, int extra); }}'; [K]::keybd_event({}, 0, 0, 0); [K]::keybd_event({}, 0, 2, 0);",
            vk, vk
        );
        return match Command::new("powershell")
            .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script])
            .output()
        {
            Ok(out) if out.status.success() => DesktopActionOutcome {
                ok: true,
                status: "executed".to_string(),
                message: format!("Sent Windows media control: {}.", label),
            },
            Ok(out) => DesktopActionOutcome {
                ok: false,
                status: "failed".to_string(),
                message: format!("Media command failed (exit {:?}).", out.status.code()),
            },
            Err(err) => DesktopActionOutcome {
                ok: false,
                status: "failed".to_string(),
                message: format!("PowerShell media command failed: {}", err),
            },
        };
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (vk, label);
        DesktopActionOutcome {
            ok: false,
            status: "not_supported".to_string(),
            message: "Hardware media key simulation is supported on Windows Desktop hosts.".to_string(),
        }
    }
}

#[tauri::command]
fn matrix_notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn matrix_collect_device_activity() -> Result<CompanionActivityPayload, String> {
    let mut sys = System::new_all();
    sys.refresh_processes(ProcessesToUpdate::All, true);

    let now_iso = Utc::now().to_rfc3339();
    let host = System::host_name().unwrap_or_else(|| "QORVYNA-Desktop".to_string());
    let os_name = System::name()
        .unwrap_or_else(|| std::env::consts::OS.to_string())
        .to_lowercase();

    let mut aggregated: HashMap<String, (String, u64, bool)> = HashMap::new();
    for process in sys.processes().values() {
        let raw_name = process.name().to_string_lossy().trim().to_string();
        if raw_name.is_empty() {
            continue;
        }
        let exe_path = process
            .exe()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let is_hidden = raw_name.starts_with('.')
            || exe_path.contains("/.")
            || exe_path.contains("\\AppData\\Local\\Temp\\");
        let run_mins = (process.run_time() / 60).clamp(1, 1440);

        let entry = aggregated
            .entry(raw_name.clone())
            .or_insert((exe_path, 0, is_hidden));
        entry.1 = entry.1.max(run_mins);
        entry.2 = entry.2 || is_hidden;
    }

    let mut apps: Vec<CompanionAppUsage> = aggregated
        .into_iter()
        .map(|(name, (pkg, mins, hidden))| CompanionAppUsage {
            name,
            package: pkg,
            minutes: mins,
            hidden,
            last_used: now_iso.clone(),
        })
        .collect();
    apps.sort_by(|a, b| b.minutes.cmp(&a.minutes));
    apps.truncate(50);

    let hidden_apps: Vec<CompanionAppUsage> = apps
        .iter()
        .filter(|app| app.hidden)
        .take(25)
        .map(|app| CompanionAppUsage {
            name: app.name.clone(),
            package: app.package.clone(),
            minutes: app.minutes,
            hidden: true,
            last_used: app.last_used.clone(),
        })
        .collect();

    let uptime_mins = (System::uptime() / 60).clamp(1, 1440);

    Ok(CompanionActivityPayload {
        device_id: format!("tauri-{}", host.to_lowercase()),
        device_name: host,
        platform: format!("{}-tauri", os_name),
        screen_time_minutes: uptime_mins,
        apps,
        hidden_apps,
        browser_history: Vec::new(),
    })
}

fn trigger_voice_activate(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("qorvyna://voice-activate", ());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed
                        && (shortcut.matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::Space)
                            || shortcut.matches(Modifiers::SUPER | Modifiers::SHIFT, Code::Space))
                    {
                        trigger_voice_activate(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let _ = app
                .global_shortcut()
                .register("CmdOrCtrl+Shift+Space");

            let show_item = MenuItem::with_id(app, "show", "Open QORVYNA AI", true, None::<&str>)?;
            let voice_item = MenuItem::with_id(app, "voice", "Speak to QORVYNA (Ctrl+Shift+Space)", true, None::<&str>)?;
            let reload_item = MenuItem::with_id(app, "reload", "Reload Workspace", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit QORVYNA AI", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &voice_item, &reload_item, &quit_item])?;

            if let Some(icon) = app.default_window_icon().cloned() {
                let _tray = TrayIconBuilder::new()
                    .icon(icon)
                    .tooltip("QORVYNA AI")
                    .menu(&menu)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "voice" => {
                            trigger_voice_activate(app);
                        }
                        "reload" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.eval("window.location.reload()");
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    })
                    .build(app)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            matrix_notify,
            matrix_collect_device_activity,
            qorvyna_desktop_info,
            desktop_hardware_status,
            launch_app,
            media_control,
            // Native bridge used by the bundled shared frontend
            // (src/native/native-bridge.ts). Every command is allowlisted
            // individually — nothing is exposed generically.
            native::qorvyna_native_info,
            native::qorvyna_permission_status,
            native::qorvyna_permission_request,
            native::qorvyna_permission_settings,
            native::qorvyna_assistant_state,
            native::qorvyna_wake_word_set,
            native::qorvyna_assistant_default_request,
            native::qorvyna_assistant_popup,
            native::qorvyna_device_fingerprint,
            native::qorvyna_inspection_state,
            native::qorvyna_inspection_stop
        ])
        .run(tauri::generate_context!())
        .expect("error while running QORVYNA AI Tauri application");
}
