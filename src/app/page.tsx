import Link from "next/link";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui";
import { t } from "@/lib/i18n";

const FEATURES = [
  {
    icon: "💬",
    title: "Cybersecurity AI Chat",
    body: "Ask anything about phishing, passwords, scams and privacy. The AI only answers cybersecurity questions — safely, calmly and without judgment.",
  },
  {
    icon: "🔍",
    title: "Screenshot Scanner",
    body: "Upload a suspicious message or login page and get a structured risk analysis: what to do now, what not to do, and how to report it.",
  },
  {
    icon: "🎓",
    title: "Courses & Certificates",
    body: "Seven teen-friendly courses with lessons, quizzes and verifiable certificates issued by MATRIX AI.",
  },
  {
    icon: "🛡️",
    title: "Scam Library",
    body: "A verified library of scam types with warning signs, prevention steps and official reporting resources — never invented by AI.",
  },
  {
    icon: "🚨",
    title: "I Need Help Now",
    body: "Account hacked? Clicked a suspicious link? Shared a code? Get immediate defensive steps for the exact situation you are in.",
  },
  {
    icon: "🔐",
    title: "Privacy by design",
    body: "Supabase PostgreSQL with Row Level Security, encrypted storage, private buckets, PII redaction before AI, and full data export & deletion.",
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-slate-200/70 bg-white/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
          <Logo />
          <nav className="flex items-center gap-2" aria-label="Main navigation">
            <Link href="/scams" className="hidden rounded-xl px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 sm:block">
              {t("nav.scams", "en")}
            </Link>
            <Link href="/courses" className="hidden rounded-xl px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 sm:block">
              {t("nav.courses", "en")}
            </Link>
            <Link href="/emergency" className="hidden rounded-xl px-3 py-2 text-sm font-medium text-amber-700 hover:bg-amber-50 sm:block">
              {t("nav.emergency", "en")}
            </Link>
            <Link href="/login">
              <Button variant="outline" className="!py-2">{t("nav.signIn", "en")}</Button>
            </Link>
            <Link href="/register">
              <Button className="!py-2">{t("nav.signUp", "en")}</Button>
            </Link>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-6xl px-4 pt-16 pb-12 text-center sm:pt-24">
        <p className="mx-auto mb-4 inline-flex items-center gap-2 rounded-full border border-brand-200 bg-brand-50 px-4 py-1.5 text-xs font-semibold text-brand-700">
          🛡️ {t("brand.byline", "en")}
        </p>
        <h1 className="mx-auto max-w-3xl text-4xl font-extrabold tracking-tight text-slate-900 sm:text-6xl">
          Your safe space to learn{" "}
          <span className="bg-gradient-to-r from-brand-600 to-brand-400 bg-clip-text text-transparent">cyber safety</span>
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-lg text-slate-600">
          MATRIX AI is a teen-first cybersecurity education platform for ages 11–17. Chat with a safety AI,
          scan suspicious messages, learn in courses, and earn certificates — all protected by enterprise-grade privacy.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link href="/register">
            <Button className="px-8 py-3 text-base">Start learning free</Button>
          </Link>
          <Link href="/chat">
            <Button variant="outline" className="px-8 py-3 text-base">Try the AI chat</Button>
          </Link>
        </div>
        <p className="mt-4 text-sm text-slate-500">
          {t("auth.ageNote", "en")} · Parental consent where required · Age verification
        </p>
      </section>

      {/* Features */}
      <section className="mx-auto max-w-6xl px-4 py-12">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="text-3xl" aria-hidden="true">{f.icon}</div>
              <h3 className="mt-3 text-lg font-bold text-slate-900">{f.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Trust section */}
      <section className="mx-auto max-w-6xl px-4 py-12">
        <div className="rounded-3xl bg-gradient-to-br from-brand-700 to-brand-900 p-8 text-white sm:p-12">
          <h2 className="text-2xl font-bold sm:text-3xl">Built like a real security platform</h2>
          <p className="mt-3 max-w-3xl text-brand-100">
            Every message, memory, report and certificate is protected by Supabase PostgreSQL with Row Level
            Security. The AI gateway redacts personal information before it ever reaches the model, refuses
            harmful requests, and never invents reporting websites.
          </p>
          <div className="mt-6 flex flex-wrap gap-2 text-xs font-semibold">
            {["Supabase Auth + RLS", "PostgreSQL", "Private storage", "PII redaction", "Groq AI Gateway", "RBAC admin", "Verifiable certificates"].map((b) => (
              <span key={b} className="rounded-full border border-white/25 bg-white/10 px-3 py-1.5">{b}</span>
            ))}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-4 py-8 text-sm text-slate-500 sm:flex-row">
          <p>
            © {new Date().getFullYear()} <span className="font-semibold text-slate-700">MATRIX AI</span> — {t("brand.byline", "en")}
          </p>
          <nav className="flex gap-4" aria-label="Footer">
            <Link href="/privacy" className="hover:text-slate-900">{t("footer.privacy", "en")}</Link>
            <Link href="/security" className="hover:text-slate-900">{t("footer.security", "en")}</Link>
            <Link href="/emergency" className="hover:text-slate-900">{t("footer.help", "en")}</Link>
            <Link href="/certificate/verify/demo" className="hover:text-slate-900">Verify a certificate</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
