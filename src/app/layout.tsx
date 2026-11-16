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
import { AuthLifecycleProvider } from "@/components/auth/auth-provider";
import { BRAND, BRAND_ASSETS, BRAND_THEME } from "@/lib/brand";
import { siteOrigin } from "@/lib/seo";

const TITLE = `${BRAND.name} — ${BRAND.headline}`;

export const metadata: Metadata = {
  // Makes the icon and social-card paths below absolute for crawlers.
  metadataBase: new URL(siteOrigin()),
  title: {
    default: TITLE,
    template: `%s · ${BRAND.name}`,
  },
  description: BRAND.description,
  applicationName: BRAND.name,
  verification: {
    google: "w7nP74RD04O12Z-gbtUMGn1cZ9SRQz9SnRY-94e1v-w",
  },
  // All artwork is generated from one drawing (scripts/generate-brand-assets.mjs)
  // and served from this origin — no third-party image host in the head.
  icons: {
    icon: [
      { url: BRAND_ASSETS.favicon, sizes: "48x48" },
      { url: BRAND_ASSETS.faviconSvg, type: "image/svg+xml" },
      { url: BRAND_ASSETS.favicon16, sizes: "16x16", type: "image/png" },
      { url: BRAND_ASSETS.favicon32, sizes: "32x32", type: "image/png" },
      { url: BRAND_ASSETS.icon192, sizes: "192x192", type: "image/png" },
    ],
    shortcut: [{ url: BRAND_ASSETS.favicon }],
    apple: [{ url: BRAND_ASSETS.appleTouchIcon, sizes: "180x180", type: "image/png" }],
  },
  manifest: "/site.webmanifest",
  appleWebApp: { capable: true, title: BRAND.name, statusBarStyle: "black-translucent" },
  openGraph: {
    title: TITLE,
    description: BRAND.description,
    type: "website",
    siteName: BRAND.name,
    images: [{ url: BRAND_ASSETS.socialPreview, width: 1200, height: 630, alt: `${BRAND.name} — ${BRAND.tagline}` }],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: BRAND.shortDescription,
    images: [BRAND_ASSETS.socialPreview],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  // Dark is the primary theme, so it is also what a device with no stated
  // preference gets for its browser chrome.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: BRAND_THEME.light },
    { media: "(prefers-color-scheme: dark)", color: BRAND_THEME.dark },
  ],
  colorScheme: "dark light",
};

// Runs before first paint so there is no theme flash. DARK is the default for
// everyone who never picked a theme — only a stored preference or an explicit
// "system" choice can land on light. It also applies the stored language and
// the background-glow strength, so neither flashes in after hydration.
// The storage keys are the ones the product has always used: renaming them
// would silently reset every existing user's theme and language.
const THEME_SCRIPT = `try{var t=localStorage.getItem('matrix-theme')||'dark';var r=t==='light'||t==='dark'?t:(t==='system'&&matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');document.documentElement.setAttribute('data-theme',r);var l=localStorage.getItem('matrix-lang');if(l==='bn'||l==='en')document.documentElement.setAttribute('lang',l);var a=localStorage.getItem('matrix-rain');document.documentElement.setAttribute('data-ambient',a==='off'||a==='subtle'||a==='normal'||a==='heavy'?a:'normal');}catch(e){document.documentElement.setAttribute('data-theme','dark');document.documentElement.setAttribute('data-ambient','normal')}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" data-ambient="normal" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {/* User media (avatars, voice clips) is served from here; brand artwork is first-party. */}
        <link rel="dns-prefetch" href="https://res.cloudinary.com" />
      </head>
      <body>
        <ThemeProvider>
          <LocaleProvider>
            {/* Starts the centralised auth lifecycle (initial auth state +
                shared onAuthStateChanged listener + backend session check) at
                application startup on every page. */}
            <AuthLifecycleProvider>
              <a href="#main" className="skip-link">
                Skip to content
              </a>
              <main id="main">{children}</main>
            </AuthLifecycleProvider>
          </LocaleProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
