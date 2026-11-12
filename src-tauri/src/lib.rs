// =============================================================================
// MATRIX AI — Tauri v2 Desktop & Companion Core
//
// Exposes:
//   1. `matrix_notify(title, body)` — native OS notifications whenever any AI
//      build, security scan, automation workflow, family mirror/lock event, or
//      ESP32 hardware event finishes.
//   2. `matrix_collect_device_activity()` — opt-in companion telemetry (app
//      usage minutes, hidden/background executables, and system uptime) for
//      both own-device inspection and consented Family supervision.
//   3. System tray icon so MATRIX stays reachable in the background and never
//      misses a completed task alert.
// =============================================================================

use chrono::Utc;
use serde::Serialize;
use std::collections::HashMap;
use sysinfo::{ProcessesToUpdate, System};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};
use tauri_plugin_notification::NotificationExt;

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
    let host = System::host_name().unwrap_or_else(|| "MATRIX-Desktop".to_string());
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let show_item = MenuItem::with_id(app, "show", "Open MATRIX AI", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit MATRIX AI", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            if let Some(icon) = app.default_window_icon().cloned() {
                let _tray = TrayIconBuilder::new()
                    .icon(icon)
                    .tooltip("MATRIX AI")
                    .menu(&menu)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
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
            matrix_collect_device_activity
        ])
        .run(tauri::generate_context!())
        .expect("error while running MATRIX AI Tauri application");
}
