import type { Metadata } from "next";
import "./globals.css";
import { DemoModeBanner } from "@/components/demo-banner";
import { isDemoMode } from "@/lib/data";

export const metadata: Metadata = {
  title: {
    default: "MATRIX AI — Cyber Safety for Teens",
    template: "%s · MATRIX AI",
  },
  description:
    "MATRIX AI is an AI Cyber Safety & Cybersecurity Education Platform for ages 11–17, operated by THAMJJ13.TOP White Hat Team.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const demo = isDemoMode();
  return (
    <html lang="en">
      <body className="font-sans">
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        {demo ? <DemoModeBanner /> : null}
        <main id="main">{children}</main>
      </body>
    </html>
  );
}
