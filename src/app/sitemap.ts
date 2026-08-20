import type { MetadataRoute } from "next";
import { DOC_SECTIONS } from "@/content/docs";
import { siteOrigin } from "@/lib/seo";

// =============================================================================
// MATRIX sitemap — served by Next.js at /sitemap.xml.
//
// Lists every page a search engine should index:
//   • the homepage and the public help / legal pages
//   • the authentication entry points (login, registration, password recovery)
//   • the complete documentation set (/docs/…)
//   • the published cyber-safety courses (/courses/…)
//   • the verified scam-library articles (/scams/…)
//
// Everything else — /chat, /dashboard, /projects, /scanner, /settings,
// /history, /report, /onboarding, /certificates, /admin/… and all API routes —
// sits behind authentication and is intentionally excluded: the middleware
// bounces logged-out crawlers to /login, so those URLs carry no public content
// and would only generate crawl errors / soft-404s in the index.
// =============================================================================

type ChangeFreq = "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";

type Entry = {
  path: string;
  priority: number;
  changeFrequency: ChangeFreq;
  lastModified?: Date;
};

// ---------------------------------------------------------------------------
// Firestore-backed, admin-managed content. These slugs are the seeded values
// from scripts/seed.mjs (`insert into public.courses` and
// `insert into public.scam_articles`). When new courses or scam articles are
// published through /admin, add their slugs here so they stay indexable.
// ---------------------------------------------------------------------------
const COURSE_SLUGS = [
  "cyber-safety-basics",
  "phishing-scam-detection",
  "password-mfa-security",
  "social-media-security",
  "privacy-digital-footprint",
  "device-security",
  "cybersecurity-fundamentals",
];

const SCAM_SLUGS = [
  "spotting-phishing-messages",
  "fake-online-shops",
  "job-task-scams",
  "fake-tech-support",
  "prize-lottery-scams",
  "friendship-romance-scams",
  "investment-crypto-scams",
  "impersonation-scams",
  "fake-apps-malware",
  "protecting-your-identity",
];

const STATIC_ENTRIES: Entry[] = [
  // Home + account entry points.
  { path: "/", priority: 1.0, changeFrequency: "daily" },
  { path: "/register", priority: 0.9, changeFrequency: "monthly" },
  { path: "/login", priority: 0.8, changeFrequency: "monthly" },
  { path: "/forgot-password", priority: 0.3, changeFrequency: "yearly" },

  // Public help & legal pages.
  { path: "/emergency", priority: 0.7, changeFrequency: "monthly" },
  { path: "/support", priority: 0.6, changeFrequency: "monthly" },
  { path: "/privacy", priority: 0.3, changeFrequency: "yearly" },
  { path: "/terms", priority: 0.3, changeFrequency: "yearly" },

  // Content indexes.
  { path: "/docs", priority: 0.8, changeFrequency: "weekly" },
  { path: "/courses", priority: 0.8, changeFrequency: "weekly" },
  { path: "/scams", priority: 0.8, changeFrequency: "weekly" },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = siteOrigin();
  const entries: MetadataRoute.Sitemap = [];

  const push = (e: Entry) => {
    entries.push({
      url: `${origin}${e.path}`,
      priority: e.priority,
      changeFrequency: e.changeFrequency,
      ...(e.lastModified ? { lastModified: e.lastModified } : {}),
    });
  };

  for (const entry of STATIC_ENTRIES) push(entry);

  // Documentation — single source of truth is src/content/docs.ts.
  for (const section of DOC_SECTIONS) {
    push({ path: `/docs/${section.slug}`, priority: 0.7, changeFrequency: "weekly" });
  }

  // Courses.
  for (const slug of COURSE_SLUGS) {
    push({ path: `/courses/${slug}`, priority: 0.7, changeFrequency: "monthly" });
  }

  // Scam library articles.
  for (const slug of SCAM_SLUGS) {
    push({ path: `/scams/${slug}`, priority: 0.6, changeFrequency: "monthly" });
  }

  return entries;
}
