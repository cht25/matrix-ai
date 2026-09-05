import type { Metadata, Viewport } from "next";
// Typography: Inter for the interface, JetBrains Mono for technical metadata.
// Both are self-hosted (no render-blocking request to fonts.googleapis.com),
// and only the weights the design system actually uses are shipped.
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./globals.css";
import { ThemeProvider } from "@/lib/theme";
import { LocaleProvider } from "@/lib/i18n/client";
import { BRAND_ICON_URL, BRAND_WORDMARK_URL } from "@/lib/brand";

export const metadata: Metadata = {
  title: {
    default: "MATRIX — All-in-one AI Assistant & Coding Agent",
    template: "%s · MATRIX",
  },
  description:
    "MATRIX is an all-in-one AI assistant for writing, learning, planning, research, digital safety and coding, with an Agent workspace, live preview and review-before-push GitHub integration.",
  applicationName: "MATRIX",
  verification: {
    google: "w7nP74RD04O12Z-gbtUMGn1cZ9SRQz9SnRY-94e1v-w",
  },
  icons: {
    icon: [
      { url: BRAND_ICON_URL, type: "image/png" },
      { url: BRAND_ICON_URL, sizes: "32x32", type: "image/png" },
      { url: BRAND_ICON_URL, sizes: "192x192", type: "image/png" },
    ],
    shortcut: [{ url: BRAND_ICON_URL, type: "image/png" }],
    apple: [{ url: BRAND_ICON_URL, sizes: "180x180", type: "image/png" }],
  },
  manifest: "/site.webmanifest",
  openGraph: {
    title: "MATRIX — All-in-one AI Assistant & Coding Agent",
    description:
      "Chat, create, learn and build in one workspace—with file-aware help, live preview and explicit GitHub push from Agent mode.",
    type: "website",
    siteName: "MATRIX",
    images: [{ url: BRAND_WORDMARK_URL, alt: "MATRIX — AI Assistant & Coding Agent" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "MATRIX — All-in-one AI Assistant & Coding Agent",
    description: "Chat, create, learn and build in one secure workspace.",
    images: [BRAND_WORDMARK_URL],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  // Light is the primary theme, so it is also the default (no media) chrome.
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#070B12" },
    { media: "(prefers-color-scheme: light)", color: "#F7F9FC" },
  ],
  colorScheme: "light dark",
};

// Runs before first paint so there is no theme flash. LIGHT is the default
// for everyone who never picked a theme — only a stored preference or an
// explicit "system" choice can land on dark.
const THEME_SCRIPT = `try{var t=localStorage.getItem('matrix-theme')||'dark';var r=t==='light'||t==='dark'?t:(t==='system'&&matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');document.documentElement.setAttribute('data-theme',r);var l=localStorage.getItem('matrix-lang');if(l==='bn'||l==='en')document.documentElement.setAttribute('lang',l);}catch(e){document.documentElement.setAttribute('data-theme','dark')}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://res.cloudinary.com" crossOrigin="" />
        <link rel="icon" type="image/png" href={BRAND_ICON_URL} />
        <link rel="apple-touch-icon" href={BRAND_ICON_URL} />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <ThemeProvider>
          <LocaleProvider>
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
