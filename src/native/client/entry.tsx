"use client";

// Standalone entry for the bundled Tauri frontend.
// Built by scripts/native/build-native-frontend.mjs into public/native/index.html
// so the app ships its own assets instead of loading a remote URL.
import { createRoot } from "react-dom/client";
// The stylesheet is compiled by Tailwind in scripts/native/build-native-frontend.mjs
// and loaded by the generated index.html, so the app uses the exact same CSS.
import { ThemeProvider } from "@/lib/theme";
import { LocaleProvider } from "@/lib/i18n/client";
import { AuthLifecycleProvider } from "@/components/auth/auth-provider";
import { PwaManager } from "@/components/pwa-manager";
import { NativeApp } from "@/native/native-app";

const container = document.getElementById("qorvyna-root");
if (container) {
  // The native shell always opens on chat; history inside the app is real.
  const startPath = typeof window !== "undefined" && window.location.pathname.length > 1
    ? `${window.location.pathname}${window.location.search}`
    : "/chat";
  createRoot(container).render(
    <ThemeProvider>
      <LocaleProvider>
        <AuthLifecycleProvider>
          <PwaManager />
          <NativeApp startPath={startPath} />
        </AuthLifecycleProvider>
      </LocaleProvider>
    </ThemeProvider>,
  );
}
