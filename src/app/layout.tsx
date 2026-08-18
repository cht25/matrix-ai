import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/lib/theme";
import { CyberBackground } from "@/components/cyber-background";
import { DemoModeBanner } from "@/components/demo-banner";
import { isDemoMode } from "@/lib/data";

export const metadata: Metadata = {
  title: {
    default: "MATRIX — AI Cyber Safety Platform",
    template: "%s · MATRIX",
  },
  description:
    "MATRIX is an AI Cyber Safety Platform for ages 11–17: cybersecurity chat, screenshot scanner, scam detection, courses and certificates. Operated by THAMJJ13.TOP White Hat Team.",
  applicationName: "MATRIX",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  manifest: "/site.webmanifest",
  openGraph: {
    title: "MATRIX — AI Cyber Safety Platform",
    description:
      "AI Cyber Safety Platform for ages 11–17. Cybersecurity chat, screenshot scanner, scam detection, courses and certificates.",
    type: "website",
    siteName: "MATRIX",
  },
};

const THEME_SCRIPT = `try{var t=localStorage.getItem('matrix-theme')||'dark';var r=t==='system'?(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'):t;document.documentElement.setAttribute('data-theme',r);}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const demo = isDemoMode();
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <ThemeProvider>
          <CyberBackground />
          <a href="#main" className="skip-link">
            Skip to content
          </a>
          {demo ? <DemoModeBanner /> : null}
          <main id="main">{children}</main>
        </ThemeProvider>
      </body>
    </html>
  );
}
