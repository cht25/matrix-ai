// =============================================================================
// /native-app — the Tauri shell mount point.
//
// The page itself is a tiny wrapper: the application is the shared QORVYNA
// frontend (src/native/native-app.tsx), which imports the website's own
// components. Nothing here duplicates a screen.
// =============================================================================
import type { Metadata } from "next";
import { NativeApp } from "@/native/native-app";

export const metadata: Metadata = { title: "QORVYNA" };

export default function NativeAppPage() {
  return <NativeApp startPath="/chat" />;
}
