import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/logo";

export const metadata: Metadata = { title: "Privacy" };

const SECTIONS = [
  {
    title: "What we store",
    body: "Your profile (name, date of birth for age verification, school, country), conversations, memories, course progress, quiz results, certificates, security events, scam reports and notification preferences. All stored in Google Cloud Firestore (Firebase) — the single source of truth.",
  },
  {
    title: "What we never store",
    body: "Passwords, OTPs, access tokens, payment details, or raw identity document numbers. Birth certificate numbers are never stored; we keep only a verification reference and a review outcome.",
  },
  {
    title: "Row Level Security",
    body: "Every user-owned record is protected by PostgreSQL Row Level Security. You can only read and modify your own data — not even the application code can bypass this from the client.",
  },
  {
    title: "AI and PII redaction",
    body: "Before your message reaches the AI, a PII redaction service removes emails, phone numbers, codes, passwords, addresses and ID-like data. The AI never sees them and is instructed never to ask for them. Normal questions—including Bangla and Banglish—are passed through; only clearly harmful operational cyber requests are stopped and redirected to safer help.",
  },
  {
    title: "Temporary chats",
    body: "Temporary chats never appear in history or search, never enter memory or summaries, and are hard-deleted after 24 hours.",
  },
  {
    title: "Your controls",
    body: "View and delete memories, disable memory or chat history, export all your data as JSON (link expires after 7 days), or delete your account entirely — after re-authentication, a server-side workflow removes and anonymises your records.",
  },
  {
    title: "Who can see your data",
    body: "Only you. Admins use role-based access control (RBAC); conversations are never shown by default — any privileged access requires an explicit reason, a time-limited grant, and an audit entry. Some countries require guardian consent for users under a certain age.",
  },
];

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-bg">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex h-16 max-w-3xl items-center justify-between px-4">
          <Logo />
          <Link href="/" className="text-sm font-medium text-accent hover:text-accent-2">← Home</Link>
        </div>
      </header>
      <main className="mx-auto max-w-3xl space-y-5 px-4 py-10">
        <h1 className="text-2xl font-display font-semibold tracking-tight text-ink sm:text-3xl">Privacy at MATRIX AI</h1>
        <p className="text-ink-2">
          MATRIX AI is operated by <strong>THAMJJ13.TOP White Hat Team</strong> for users aged 11–17.
          Privacy is not a feature here — it is the architecture.
        </p>
        {SECTIONS.map((s) => (
          <section key={s.title} className="rounded-lg border border-border bg-surface p-5">
            <h2 className="font-bold text-ink">{s.title}</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{s.body}</p>
          </section>
        ))}
        <p className="pb-8 text-sm text-ink-3">
          Questions? Contact the <strong>THAMJJ13.TOP White Hat Team</strong> through your parent or guardian.
        </p>
      </main>
    </div>
  );
}
