// =============================================================================
// System assistant — desktop popup, Android bubble/ASSIST role, on-device wake
//
// Neither a Windows build nor an Android device exists in this sandbox, so the
// native halves are pinned the way the notification service already is:
//
//   1. source invariants — the window really is always-on-top/frameless and
//      loads the shared bundle, the Kotlin really uses the platform APIs and
//      really asks the OS instead of assuming a permission;
//   2. an executable mirror of the wake-word maths (mel filterbank, DCT, DTW)
//      so the matching algorithm is tested, not just grepped for.
//
// Anything that needs a device (Gradle, a real microphone, the ASSIST role) is
// listed in WINDOWS_BUILD_GUIDE.md / the Android section as manual verification.
// =============================================================================
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");

const ASSISTANT_RS = read("src-tauri/src/assistant.rs");
const NATIVE_RS = read("src-tauri/src/native.rs");
const LIB_RS = read("src-tauri/src/lib.rs");
const CAPABILITIES = read("src-tauri/capabilities/default.json");
const ENTRY = read("src/native/client/entry.tsx");
const POPUP = read("src/native/assistant-popup.tsx");
const BRIDGE = read("src/native/native-bridge.ts");
const PANEL = read("src/components/voice/native-assistant-panel.tsx");
const MANIFEST_SCRIPT = read("scripts/native/patch-android-manifest.mjs");

const KOTLIN_DIR = "src-tauri/android/app/src/main/kotlin/ai/matrix/desktop";
const KOTLIN = {
  plugin: read(`${KOTLIN_DIR}/AssistantPlugin.kt`),
  service: read(`${KOTLIN_DIR}/QorvynaAssistantService.kt`),
  wake: read(`${KOTLIN_DIR}/QorvynaWakeWord.kt`),
  assist: read(`${KOTLIN_DIR}/AssistActivity.kt`),
};

// ---------------------------------------------------------------------------
// Desktop popup (Windows/macOS/Linux)
// ---------------------------------------------------------------------------

describe("desktop floating assistant is a real always-on-top window", () => {
  it("creates the `assistant` window from the shared bundled frontend", () => {
    expect(ASSISTANT_RS).toContain('pub const ASSISTANT_WINDOW: &str = "assistant"');
    // Same bundle, popup variant — never a second app or a second build.
    expect(ASSISTANT_RS).toContain('pub const ASSISTANT_URL: &str = "index.html?window=assistant"');
    expect(ASSISTANT_RS).toContain("WebviewWindowBuilder::new");
    expect(ASSISTANT_RS).toContain("WebviewUrl::App");
    // Lazy create + reuse: a second hotkey press toggles, it does not build a
    // second window.
    expect(ASSISTANT_RS).toContain("app.get_webview_window(ASSISTANT_WINDOW)");
  });

  it("is frameless, always on top and out of the taskbar", () => {
    expect(ASSISTANT_RS).toContain(".decorations(false)");
    expect(ASSISTANT_RS).toContain(".always_on_top(true)");
    expect(ASSISTANT_RS).toContain(".skip_taskbar(true)");
    expect(ASSISTANT_RS).toContain(".inner_size(400.0, 540.0)");
    // Hidden at creation so nothing flashes before the first hotkey press.
    expect(ASSISTANT_RS).toContain(".visible(false)");
  });

  it("supports show / hide / toggle / state and nothing else", () => {
    for (const action of ['"show"', '"hide"', '"toggle"', '"state"']) {
      expect(ASSISTANT_RS).toContain(action);
    }
    expect(ASSISTANT_RS).toContain("UNKNOWN_ACTION");
    // Every mutation returns the real visibility, so the UI cannot drift.
    expect(ASSISTANT_RS).toContain('"shown": show');
  });

  it("starts a turn when it is shown, and can hand back to the main window", () => {
    expect(ASSISTANT_RS).toContain('window.emit("qorvyna://voice-activate"');
    expect(ASSISTANT_RS).toContain("pub fn open_main");
    expect(LIB_RS).toContain("native::qorvyna_assistant_open_main");
  });

  it("is driven by Ctrl+Shift+Space, with the in-app bar as the fallback", () => {
    expect(LIB_RS).toContain("popup_or_main");
    expect(LIB_RS).toContain('assistant::popup(app, "toggle")');
    expect(LIB_RS).toContain("trigger_voice_activate");
  });

  it("is allowed by the capability file the frontend runs under", () => {
    const capabilities = JSON.parse(CAPABILITIES) as { windows: string[] };
    expect(capabilities.windows).toContain("main");
    expect(capabilities.windows).toContain("assistant");
  });
});

describe("the popup window renders the shared popup surface", () => {
  it("routes ?window=assistant to the assistant, everything else to the app", () => {
    expect(ENTRY).toContain("isAssistantWindow(window.location.search)");
    expect(ENTRY).toContain("<AssistantPopup />");
    // The full shell must still mount for a normal window.
    expect(ENTRY).toContain("<NativeApp startPath={startPath} />");
  });

  it("recognises only the exact popup route", async () => {
    const { isAssistantWindow } = await import("../src/native/assistant-popup");
    expect(isAssistantWindow("?window=assistant")).toBe(true);
    expect(isAssistantWindow("?window=assistant&x=1")).toBe(true);
    expect(isAssistantWindow("")).toBe(false);
    expect(isAssistantWindow("?window=main")).toBe(false);
    expect(isAssistantWindow("?window=assistantx")).toBe(false);
  });

  it("sends one transcript exactly once, through the turn ledger", async () => {
    expect(POPUP).toContain("createVoiceTurnLedger");
    expect(POPUP).toContain("ledger.current.claim(turnId)");
    expect(POPUP).toContain("ledger.current.release(turnId)");
    // Exactly one chat dispatch in the popup, with the voice provenance flag.
    const dispatches = POPUP.match(/fetch\("\/api\/ai"/g) ?? [];
    expect(dispatches).toHaveLength(1);
    expect(POPUP).toContain('input_source: "voice"');
    // The recording survives a failed transcription: Retry re-sends the clip.
    expect(POPUP).toContain("setRetryClip(clip)");
  });

  it("merges typed and spoken text without double spaces", async () => {
    const { assistantTurnPrompt } = await import("../src/native/assistant-popup");
    expect(assistantTurnPrompt("play jazz")).toBe("play jazz");
    expect(assistantTurnPrompt("play jazz", "please ")).toBe("please play jazz");
  });
});

// ---------------------------------------------------------------------------
// Android bridge + service
// ---------------------------------------------------------------------------

describe("Android assistant bridge is declared, not assumed", () => {
  it("registers the Kotlin plugin class Rust calls into", () => {
    expect(ASSISTANT_RS).toContain('tauri::plugin::Builder::new("qorvyna-assistant")');
    expect(ASSISTANT_RS).toContain('api.register_android_plugin("ai.matrix.desktop", "AssistantPlugin")');
    expect(KOTLIN.plugin).toContain("package ai.matrix.desktop");
    expect(KOTLIN.plugin).toContain("@TauriPlugin");
    expect(KOTLIN.plugin).toContain("class AssistantPlugin(");
    // The commands Rust sends must exist on the Kotlin side.
    for (const command of ["fun state(", "fun popup(", "fun wake("]) {
      expect(KOTLIN.plugin).toContain(`@Command\n    ${command}`);
    }
  });

  it("reports ASSISTANT_UNAVAILABLE instead of pretending the bubble exists", () => {
    expect(ASSISTANT_RS).toContain("ASSISTANT_UNAVAILABLE");
    expect(ASSISTANT_RS).toContain("run_mobile_plugin");
  });

  it("reads overlay / wake / assistant-role state from the platform", () => {
    expect(KOTLIN.service).toContain("Settings.canDrawOverlays");
    expect(KOTLIN.service).toContain("Intent.ACTION_ASSIST");
    expect(KOTLIN.service).toContain("isDefaultAssistant");
    for (const field of ["overlayGranted", "wakeWordReady", "defaultAssistant", "detail"]) {
      expect(KOTLIN.plugin).toContain(`"${field}"`);
    }
    // Rust only ever reports what the service reported.
    expect(NATIVE_RS).toContain('state.get("overlayGranted")');
    expect(NATIVE_RS).toContain('state.get("wakeWordReady")');
    expect(NATIVE_RS).toContain("android && wake_model");
  });

  it("keeps the floating bubble on a real overlay window", () => {
    expect(KOTLIN.service).toContain("TYPE_APPLICATION_OVERLAY");
    expect(KOTLIN.service).toContain("WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE");
    // A foreground service is what keeps it alive; microphone type is required
    // from Android 14 for a recording service.
    expect(KOTLIN.service).toContain("startForeground(NOTIFICATION_ID");
    expect(MANIFEST_SCRIPT).toContain('android:foregroundServiceType="microphone"');
    expect(MANIFEST_SCRIPT).toContain("android.permission.FOREGROUND_SERVICE_MICROPHONE");
  });

  it("gives QORVYNA the digital-assistant role through the ASSIST intent", () => {
    expect(KOTLIN.assist).toContain("Intent.ACTION_ASSIST");
    expect(MANIFEST_SCRIPT).toContain('android:name="android.intent.action.ASSIST"');
    expect(MANIFEST_SCRIPT).toContain('android:name="android.intent.category.DEFAULT"');
    expect(MANIFEST_SCRIPT).toContain("android:exported=\"true\"");
  });

  it("copies the Kotlin sources into the generated project (idempotently)", () => {
    expect(MANIFEST_SCRIPT).toContain("app/src/main/java");
    expect(MANIFEST_SCRIPT).toContain("QorvynaAssistantService");
    expect(MANIFEST_SCRIPT).toContain("AssistActivity");
    expect(MANIFEST_SCRIPT).toContain("already declared");
    // It must not invent a project when `tauri android init` has not run.
    expect(MANIFEST_SCRIPT).toContain("never invents a project");
  });

  it("has one implementation of every Kotlin class in the app package", () => {
    const files = ["AssistantPlugin.kt", "QorvynaAssistantService.kt", "QorvynaWakeWord.kt", "AssistActivity.kt"];
    for (const file of files) {
      expect(existsSync(path.join(ROOT, KOTLIN_DIR, file)), `missing ${file}`).toBe(true);
    }
  });
});

describe("the wake phrase is a real on-device engine", () => {
  it("captures PCM at 16 kHz and never uses the network", () => {
    expect(KOTLIN.wake).toContain("SAMPLE_RATE = 16_000");
    expect(KOTLIN.service).toContain("AudioRecord(");
    expect(KOTLIN.service).toContain("MediaRecorder.AudioSource.VOICE_RECOGNITION");
    for (const network of ["HttpURLConnection", "OkHttp", "java.net.URL", "Socket", "Retrofit"]) {
      expect(KOTLIN.wake).not.toContain(network);
      expect(KOTLIN.service).not.toContain(network);
    }
  });

  it("computes MFCC features (pre-emphasis, Hamming, FFT, mel, DCT, CMN)", () => {
    expect(KOTLIN.wake).toContain("0.97 * previous");
    expect(KOTLIN.wake).toContain("fun powerSpectrum");
    expect(KOTLIN.wake).toContain("fun buildMelFilters");
    expect(KOTLIN.wake).toContain("fun buildDct");
    expect(KOTLIN.wake).toContain("MEL_BANDS = 26");
    expect(KOTLIN.wake).toContain("CEPSTRA = 13");
    expect(KOTLIN.wake).toContain("fun cepstralMeanNormalise");
  });

  it("matches with banded DTW and requires two consecutive hits", () => {
    expect(KOTLIN.wake).toContain("fun dtw(");
    expect(KOTLIN.wake).toContain("Sakoe-Chiba");
    expect(KOTLIN.service).toContain("consecutiveHits");
    // One turn at most every three seconds: no machine-gun activation.
    expect(KOTLIN.service).toContain("< 3000");
  });

  it("stores enrolment on the device and can forget it", () => {
    expect(KOTLIN.wake).toContain("getSharedPreferences");
    expect(KOTLIN.wake).toContain("fun enrol(");
    expect(KOTLIN.wake).toContain("fun clear()");
    expect(KOTLIN.plugin).toContain('"clear"');
    expect(NATIVE_RS).toContain("qorvyna_wake_word_clear");
  });

  it("only reports wake support when a model is enrolled and enabled", () => {
    expect(KOTLIN.plugin).toContain('put("wakeWordReady", ready)');
    expect(KOTLIN.plugin).toContain('put("templates", templates)');
    expect(NATIVE_RS).toContain("wake_samples");
    expect(NATIVE_RS).toContain("wake_required");
    expect(BRIDGE).toContain("wakeSamples: number");
    expect(BRIDGE).toContain("wakeRequired: number");
  });

  it("hands a wake hit to the UI exactly once", () => {
    // The service persists a pending flag and Rust clears it on read.
    expect(KOTLIN.service).toContain("KEY_PENDING");
    expect(KOTLIN.service).toContain("fun takePending(");
    expect(NATIVE_RS).toContain("pub fn qorvyna_assistant_take_pending");
    expect(LIB_RS).toContain("native::qorvyna_assistant_take_pending");
    expect(BRIDGE).toContain('"qorvyna_assistant_take_pending"');
  });
});

// ---------------------------------------------------------------------------
// Executable mirror of the wake-word maths
// ---------------------------------------------------------------------------

/** Same band and rejection rule as QorvynaWakeWord.dtw (Kotlin). */
function dtw(a: number[][], b: number[][]): number {
  if (a.length === 0 || b.length === 0) return Number.POSITIVE_INFINITY;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (longer.length > shorter.length * 2) return Number.POSITIVE_INFINITY;
  const rows = shorter.length;
  const columns = longer.length;
  const band = Math.max(12, Math.max(rows, columns) / 6);
  const infinity = 1e18;
  const Euclidean = (x: number[], y: number[]) => {
    let sum = 0;
    for (let index = 0; index < x.length; index += 1) {
      const delta = x[index] - y[index];
      sum += delta * delta;
    }
    return Math.sqrt(sum / Math.max(1, x.length));
  };
  let previous = new Array(columns).fill(infinity);
  let current = new Array(columns).fill(infinity);
  for (let row = 0; row < rows; row += 1) {
    current = new Array(columns).fill(infinity);
    const from = Math.max(0, row - Math.trunc(band));
    const to = Math.min(columns - 1, row + Math.trunc(band));
    for (let column = from; column <= to; column += 1) {
      const cost = Euclidean(shorter[row], longer[column]);
      if (row === 0 && column === 0) {
        current[column] = cost;
        continue;
      }
      let best = infinity;
      if (row > 0) best = Math.min(best, previous[column]);
      if (column > 0) best = Math.min(best, current[column - 1]);
      if (row > 0 && column > 0) best = Math.min(best, previous[column - 1]);
      current[column] = best >= infinity ? infinity : cost + best;
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  const total = previous[columns - 1];
  return total >= infinity ? Number.POSITIVE_INFINITY : total / (rows + columns);
}

const frame = (value: number) => [value, value, value];

describe("wake-word matching maths behaves like the Kotlin engine", () => {
  it("scores identical utterances at zero", () => {
    const utterance = [frame(1), frame(2), frame(3), frame(4)];
    expect(dtw(utterance, utterance)).toBe(0);
  });

  it("scores a time-shifted utterance far below a different one", () => {
    const enrolled = [frame(0), frame(3), frame(6), frame(3), frame(0)];
    const shifted = [frame(0), frame(0), frame(3), frame(6), frame(3), frame(0)];
    const different = [frame(9), frame(-9), frame(9), frame(-9), frame(9)];
    const near = dtw(shifted, enrolled);
    const far = dtw(different, enrolled);
    expect(near).toBeLessThan(far);
    expect(far - near).toBeGreaterThan(1);
  });

  it("rejects a length mismatch larger than 2x before aligning", () => {
    const short = [frame(1), frame(2), frame(3)];
    const long = Array.from({ length: 30 }, (_, index) => frame(index % 5));
    expect(dtw(short, long)).toBe(Number.POSITIVE_INFINITY);
  });

  it("never returns a negative or NaN cost", () => {
    const a = [frame(0.5), frame(-0.25), frame(1)];
    const b = [frame(0.4), frame(-0.2)];
    const cost = dtw(a, b);
    expect(Number.isFinite(cost)).toBe(true);
    expect(cost).toBeGreaterThanOrEqual(0);
  });

  it("keeps the threshold a plain number the UI can explain", () => {
    const threshold = Number(/DEFAULT_THRESHOLD = ([\d.]+)/.exec(KOTLIN.wake)?.[1]);
    expect(Number.isFinite(threshold)).toBe(true);
    expect(threshold).toBeGreaterThan(20);
    expect(threshold).toBeLessThan(90);
    // Enrolment needs at least two samples before it is "ready".
    expect(KOTLIN.wake).toContain("MIN_TEMPLATES = 2");
    expect(KOTLIN.wake).toContain("MAX_TEMPLATES = 5");
  });
});

// ---------------------------------------------------------------------------
// UI surface
// ---------------------------------------------------------------------------

describe("the assistant panel drives the real controls", () => {
  it("offers the Android grants and the desktop popup, never a fake toggle", () => {
    expect(PANEL).toContain("enrolWakeWordSample");
    expect(PANEL).toContain("clearWakeWordSamples");
    expect(PANEL).toContain("openAssistantSettings(\"overlay\")");
    expect(PANEL).toContain("openAssistantSettings(\"assistant\")");
    expect(PANEL).toContain("toggleAssistantPopup");
    // Platform split: the Android-only rows stay out of the desktop build.
    expect(PANEL).toContain('state.platform === "android"');
    expect(PANEL).toContain("Ctrl+Shift+Space");
  });

  it("is mounted in the voice settings the user already opens", () => {
    const bar = read("src/components/voice/jarvis-assistant-bar.tsx");
    expect(bar).toContain("<NativeAssistantPanel />");
    expect(bar).toContain('from "@/components/voice/native-assistant-panel"');
  });

  it("explains itself in a browser instead of pretending the popup exists", () => {
    expect(PANEL).toContain("needs the installed app");
  });
});
