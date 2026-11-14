// =============================================================================
// MATRIX Phone-First App Release & OTA Update System
//
// Powers `GET /api/app/version` and Admin release management (`system_settings/app_releases`).
// Supports Android companion APK updates (optional update sheet + mandatory
// `min_supported_version` / `force_update` gate), mobile web/PWA version checks,
// and Tauri desktop release metadata.
// =============================================================================

import type { Db } from "@/lib/firebase/admin";
import { nowTs } from "@/lib/firebase/admin";
import { chatOriginUrl, siteOrigin } from "@/lib/seo";
import { RpcError } from "@/lib/server/errors";

const COLLECTION = "system_settings";
const DOC_ID = "app_releases";

export type AppPlatform = "android" | "web" | "desktop";

export type AppReleaseRecord = {
  version: string;
  build_number: number;
  min_supported_version: string;
  force_update: boolean;
  apk_url: string;
  sha256: string;
  release_notes: string;
  published_at: string;
  updated_by?: string;
};

export type AppUpdateEvaluation = {
  ok: true;
  platform: AppPlatform;
  latest_version: string;
  latest_build: number;
  min_supported_version: string;
  current_version: string | null;
  current_build: number | null;
  update_available: boolean;
  force_update: boolean;
  apk_url: string;
  download_url: string;
  web_url: string;
  chat_url: string;
  sha256: string;
  release_notes: string;
  published_at: string;
  checked_at: string;
};

export const DEFAULT_ANDROID_APK_URL =
  "https://github.com/cht25/matrix-ai/releases/latest/download/matrix-android.apk";

export const SHIPPED_APP_RELEASE: AppReleaseRecord = {
  version: "1.1.0",
  build_number: 2,
  min_supported_version: "1.0.0",
  force_update: false,
  apk_url: process.env.MATRIX_ANDROID_APK_URL?.trim() || DEFAULT_ANDROID_APK_URL,
  sha256: process.env.MATRIX_ANDROID_APK_SHA256?.trim() || "",
  release_notes:
    "• One model for everything: GPT OSS 120B powers Chat, Agent, website generation and coding\n" +
    "• Compact Arena-style live step timeline\n" +
    "• Over-the-air phone update checker & direct matrix.thamjj13.top/chat sync",
  published_at: "2026-11-12T00:00:00.000Z",
};

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function isValidSemver(value: string): boolean {
  return SEMVER_RE.test(value.trim());
}

function parseParts(version: string): [number, number, number] {
  const core = version.trim().replace(/^v/i, "").split("-")[0] ?? "0.0.0";
  const [maj, min, pat] = core.split(".").map((n) => {
    const parsed = Number.parseInt(n ?? "0", 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  });
  return [maj ?? 0, min ?? 0, pat ?? 0];
}

/** Returns -1 if a < b, 0 if a == b, 1 if a > b. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parseParts(a);
  const pb = parseParts(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

function asIso(value: unknown, fallback: string): string {
  if (!value) return fallback;
  if (typeof value === "string" && value.trim()) return value;
  const ts = value as { toDate?: () => Date; toMillis?: () => number };
  if (typeof ts.toDate === "function") return ts.toDate().toISOString();
  if (typeof ts.toMillis === "function") return new Date(ts.toMillis()).toISOString();
  return fallback;
}

export async function getAppReleaseConfig(d: Db | null): Promise<AppReleaseRecord> {
  if (!d) return { ...SHIPPED_APP_RELEASE };
  try {
    const snap = await d.collection(COLLECTION).doc(DOC_ID).get();
    if (!snap.exists) return { ...SHIPPED_APP_RELEASE };
    const raw = snap.data() ?? {};
    const version = typeof raw.version === "string" && isValidSemver(raw.version)
      ? raw.version.trim()
      : SHIPPED_APP_RELEASE.version;
    const minSupported = typeof raw.min_supported_version === "string" && isValidSemver(raw.min_supported_version)
      ? raw.min_supported_version.trim()
      : SHIPPED_APP_RELEASE.min_supported_version;
    const buildNum = typeof raw.build_number === "number" && Number.isInteger(raw.build_number) && raw.build_number >= 1
      ? raw.build_number
      : SHIPPED_APP_RELEASE.build_number;
    const apkUrl = typeof raw.apk_url === "string" && raw.apk_url.trim().startsWith("https://")
      ? raw.apk_url.trim()
      : SHIPPED_APP_RELEASE.apk_url;
    return {
      version,
      build_number: buildNum,
      min_supported_version: minSupported,
      force_update: raw.force_update === true,
      apk_url: apkUrl,
      sha256: typeof raw.sha256 === "string" ? raw.sha256.trim().slice(0, 128) : "",
      release_notes: typeof raw.release_notes === "string" && raw.release_notes.trim()
        ? raw.release_notes.trim().slice(0, 4000)
        : SHIPPED_APP_RELEASE.release_notes,
      published_at: asIso(raw.published_at ?? raw.updated_at, SHIPPED_APP_RELEASE.published_at),
      updated_by: typeof raw.updated_by === "string" ? raw.updated_by : "",
    };
  } catch {
    return { ...SHIPPED_APP_RELEASE };
  }
}

export async function saveAppReleaseConfig(
  d: Db,
  updaterUid: string,
  input: {
    version: string;
    build_number: number;
    min_supported_version: string;
    force_update?: boolean;
    apk_url?: string;
    sha256?: string;
    release_notes?: string;
  },
): Promise<AppReleaseRecord> {
  const version = input.version.trim().replace(/^v/i, "");
  const minSupported = input.min_supported_version.trim().replace(/^v/i, "");
  if (!isValidSemver(version)) throw new RpcError("APP_VERSION_INVALID", 400);
  if (!isValidSemver(minSupported)) throw new RpcError("APP_MIN_VERSION_INVALID", 400);
  if (compareSemver(minSupported, version) === 1) {
    throw new RpcError("APP_MIN_VERSION_EXCEEDS_LATEST", 400);
  }
  const buildNumber = Math.floor(Number(input.build_number));
  if (!Number.isFinite(buildNumber) || buildNumber < 1 || buildNumber > 1_000_000) {
    throw new RpcError("APP_BUILD_NUMBER_INVALID", 400);
  }
  const rawApk = (input.apk_url ?? "").trim() || DEFAULT_ANDROID_APK_URL;
  try {
    const parsed = new URL(rawApk);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new RpcError("APP_APK_URL_INVALID", 400);
    }
  } catch (err) {
    if (err instanceof RpcError) throw err;
    throw new RpcError("APP_APK_URL_INVALID", 400);
  }
  const sha256 = (input.sha256 ?? "").trim();
  if (sha256 && !/^[a-fA-F0-9]{64}$/.test(sha256)) {
    throw new RpcError("APP_SHA256_INVALID", 400);
  }
  const notes = (input.release_notes ?? "").trim().slice(0, 4000) || SHIPPED_APP_RELEASE.release_notes;
  const now = nowTs();
  await d.collection(COLLECTION).doc(DOC_ID).set(
    {
      version,
      build_number: buildNumber,
      min_supported_version: minSupported,
      force_update: input.force_update === true,
      apk_url: rawApk,
      sha256: sha256.toLowerCase(),
      release_notes: notes,
      published_at: now,
      updated_at: now,
      updated_by: updaterUid,
    },
    { merge: true },
  );
  return getAppReleaseConfig(d);
}

export function evaluateAppUpdate(
  release: AppReleaseRecord,
  opts: {
    platform?: AppPlatform;
    currentVersion?: string | null;
    currentBuild?: number | null;
  } = {},
): AppUpdateEvaluation {
  const platform: AppPlatform = opts.platform ?? "android";
  const currentVersion = opts.currentVersion?.trim() ? opts.currentVersion.trim().replace(/^v/i, "") : null;
  const currentBuild = typeof opts.currentBuild === "number" && Number.isFinite(opts.currentBuild) && opts.currentBuild > 0
    ? Math.floor(opts.currentBuild)
    : null;

  let updateAvailable = false;
  let belowMinimum = false;

  if (currentVersion && isValidSemver(currentVersion)) {
    const cmpLatest = compareSemver(currentVersion, release.version);
    if (cmpLatest === -1) {
      updateAvailable = true;
    } else if (cmpLatest === 0 && currentBuild !== null && currentBuild < release.build_number) {
      updateAvailable = true;
    }
    if (compareSemver(currentVersion, release.min_supported_version) === -1) {
      belowMinimum = true;
      updateAvailable = true;
    }
  } else if (currentBuild !== null && currentBuild < release.build_number) {
    updateAvailable = true;
  }

  const forceUpdate = updateAvailable && (belowMinimum || release.force_update);
  const webUrl = siteOrigin();
  const chatUrl = chatOriginUrl();

  return {
    ok: true,
    platform,
    latest_version: release.version,
    latest_build: release.build_number,
    min_supported_version: release.min_supported_version,
    current_version: currentVersion,
    current_build: currentBuild,
    update_available: updateAvailable,
    force_update: forceUpdate,
    apk_url: release.apk_url,
    download_url: platform === "android" ? release.apk_url : chatUrl,
    web_url: webUrl,
    chat_url: chatUrl,
    sha256: release.sha256,
    release_notes: release.release_notes,
    published_at: release.published_at,
    checked_at: new Date().toISOString(),
  };
}
