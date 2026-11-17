// Single source of truth for QORVYNA client/app version metadata.
// Synchronized with package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml,
// and mobile/matrix_app/pubspec.yaml.

export const APP_VERSION = "1.2.0";
export const APP_BUILD_NUMBER = 3;
export const APP_RELEASE_TAG = `${APP_VERSION}+${APP_BUILD_NUMBER}`;
