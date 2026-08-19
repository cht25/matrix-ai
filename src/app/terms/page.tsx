import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/logo";

export const metadata: Metadata = { title: "Terms of Service" };

const SECTIONS = [
  { title: "1. Who we are", body: "MATRIX is an AI Cyber Safety Platform operated by THAMJJ13.TOP White Hat Team, designed for users aged 11–17." },
  { title: "2. Eligibility", body: "You must be between 11 and 17 years old to use MATRIX. Age is verified during registration. In countries where guardian consent is required, a parent or guardian must provide consent before you use the platform." },
  { title: "3. Using MATRIX", body: "MATRIX provides cybersecurity education, AI chat, screenshot analysis, a scam library, courses and certificates. The AI answers cybersecurity-related questions only and refuses harmful requests. You agree to use MATRIX for defensive, lawful purposes only." },
  { title: "4. Your account", body: "You are responsible for keeping your password private. Never share your password, one-time codes, or recovery codes with anyone — including friends. If you believe your account was compromised, tell a trusted adult and use the Security page immediately." },
  { title: "5. Content you create", body: "Your conversations, reports and memories belong to you. You can export or delete them at any time from Settings. MATRIX does not claim ownership of your content." },
  { title: "6. Privacy", body: "Your data is protected by Firebase security rules and server-side authorization. Personal information is redacted before it reaches the AI. See the Privacy page for full details." },
  { title: "7. Certificates", body: "Certificates are issued upon course completion and can be verified publicly. They may be revoked if they were obtained improperly or if a course is found to contain errors." },
  { title: "8. Acceptable use", body: "You may not: attempt to access another user's data, abuse the AI for harmful purposes, upload malware or illegal content, attempt to bypass safety or rate limits, or use MATRIX to harass anyone." },
  { title: "9. Safety and emergencies", body: "MATRIX is an educational tool, not an emergency service. If you are in immediate danger, threatened, or being blackmailed, tell a trusted adult or contact local emergency services." },
  { title: "10. Changes", body: "We may update these terms. Significant changes will be communicated through the platform." },
  { title: "11. Contact", body: "Questions about these terms? Ask a parent or guardian to contact the THAMJJ13.TOP White Hat Team through the Support page." },
];

export default function TermsPage() {
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-40 border-b border-border bg-surface/85 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-4">
          <Logo size="sm" />
          <Link href="/" className="text-sm font-medium text-accent hover:text-accent-2">← Home</Link>
        </div>
      </header>
      <main className="mx-auto max-w-3xl space-y-5 px-4 py-10">
        <h1 className="text-2xl font-display font-semibold tracking-tight text-ink sm:text-3xl">Terms of Service</h1>
        <p className="text-sm text-ink-3">Last updated: August 2026 · MATRIX — THAMJJ13.TOP White Hat Team</p>
        {SECTIONS.map((s) => (
          <section key={s.title} className="card p-5">
            <h2 className="font-bold text-ink">{s.title}</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{s.body}</p>
          </section>
        ))}
        <p className="pb-8 text-sm text-ink-3">
          By using MATRIX you agree to these terms and to the <Link href="/privacy" className="text-accent hover:underline">Privacy Policy</Link>.
        </p>
      </main>
    </div>
  );
}
