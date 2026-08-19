import type { Metadata, Viewport } from "next";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/manrope/500.css";
import "@fontsource/manrope/600.css";
import "./globals.css";
import { ThemeProvider } from "@/lib/theme";
import { LocaleProvider } from "@/lib/i18n/client";
import { CyberBackground } from "@/components/cyber-background";

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

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#050608" },
    { media: "(prefers-color-scheme: light)", color: "#f4f5f7" },
  ],
};

const THEME_SCRIPT = `try{var t=localStorage.getItem('matrix-theme')||'dark';var r=t==='system'?(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'):t;document.documentElement.setAttribute('data-theme',r);var l=localStorage.getItem('matrix-lang');if(l==='bn'||l==='en')document.documentElement.setAttribute('lang',l);}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <ThemeProvider>
          <LocaleProvider>
            <CyberBackground />
            <a href="#main" className="skip-link">
              Skip to content
            </a>
            <main id="main">{children}</main>
          </LocaleProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
