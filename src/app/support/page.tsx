import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui";

export const metadata: Metadata = { title: "Support" };

const TOPICS = [
  { icon: "🚨", title: "Emergency help", body: "Account hacked, OTP shared, money lost or being threatened? Get immediate defensive steps.", href: "/emergency", cta: "I Need Help Now" },
  { icon: "📚", title: "Documentation", body: "Guides for every part of MATRIX: chat, scanner, courses, certificates, privacy and more.", href: "/docs", cta: "Read the docs" },
  { icon: "📢", title: "Report a scam", body: "File a private report or find the verified official reporting resource for your country.", href: "/report", cta: "Report a scam" },
  { icon: "❓", title: "FAQ", body: "Common questions about accounts, age verification, the AI, memory and deletion.", href: "/docs/faq", cta: "Open the FAQ" },
];

export default function SupportPage() {
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-40 border-b border-border bg-surface/85 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-4">
          <Logo size="sm" />
          <Link href="/" className="text-sm font-medium text-accent hover:text-accent-2">← Home</Link>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-2xl font-extrabold text-ink sm:text-3xl">Support</h1>
        <p className="mt-2 text-ink-2">
          MATRIX support is operated by the <strong>THAMJJ13.TOP White Hat Team</strong>. For privacy reasons,
          account-specific help is only available to signed-in users — never share passwords or codes with anyone.
        </p>
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {TOPICS.map((t) => (
            <div key={t.title} className="card card-hover flex flex-col !p-5">
              <span className="text-2xl" aria-hidden="true">{t.icon}</span>
              <h2 className="mt-2 font-bold text-ink">{t.title}</h2>
              <p className="mt-1 flex-1 text-sm text-ink-2">{t.body}</p>
              <Link href={t.href} className="mt-3"><Button variant="outline" className="w-full">{t.cta} →</Button></Link>
            </div>
          ))}
        </div>
        <div className="card mt-8 !p-6 text-center">
          <h2 className="font-bold text-ink">Still need help?</h2>
          <p className="mt-1 text-sm text-ink-2">
            Ask a parent or guardian to contact the THAMJJ13.TOP White Hat Team via the project's official
            channels. Include your account email (never your password or codes).
          </p>
        </div>
      </main>
    </div>
  );
}
