import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/logo";
import { Button, Card } from "@/components/ui";

export const metadata: Metadata = { title: "I Need Help Now" };

type EmergencyCategory = {
  id: string;
  icon: string;
  title: string;
  steps: string[];
  warning?: string;
};

const CATEGORIES: EmergencyCategory[] = [
  {
    id: "account-hacked",
    icon: "🔑",
    title: "Account hacked",
    steps: [
      "Change the password immediately — from a device you trust.",
      "Sign out of all devices (most apps have a 'log out everywhere' option).",
      "Turn on two-factor authentication (2FA) right away.",
      "Check recovery email and phone number are still yours.",
      "Tell a trusted adult and report to the platform's support.",
    ],
  },
  {
    id: "link-clicked",
    icon: "🔗",
    title: "Suspicious link clicked",
    steps: [
      "Do not enter any passwords or codes on any page it opened.",
      "Close the page. Do not download anything it suggested.",
      "Change the password of any account you typed details into.",
      "Run a security check on your device if you downloaded a file.",
      "Tell a trusted adult what happened.",
    ],
  },
  {
    id: "otp-shared",
    icon: "🔢",
    title: "OTP / verification code shared",
    steps: [
      "That code is a key to your account — act fast but calmly.",
      "Sign out of all sessions and change your password.",
      "Check for new devices or logins on the account.",
      "Contact the real company through its official support channel.",
      "Tell a trusted adult immediately.",
    ],
  },
  {
    id: "money-lost",
    icon: "💸",
    title: "Money lost",
    steps: [
      "Tell a trusted adult right away — you are not in trouble.",
      "Contact the bank or payment provider to try to stop the payment.",
      "Keep all evidence: screenshots, receipts, messages.",
      "Do NOT pay any more money, no matter what the scammer promises.",
      "Report to the official reporting organisation for your country.",
    ],
  },
  {
    id: "malware",
    icon: "🦠",
    title: "Malware suspicion",
    steps: [
      "Stop using the device for important accounts (email, banking).",
      "Run a reputable security scan.",
      "Remove suspicious apps — especially ones you sideloaded.",
      "Change important passwords from a different device.",
      "Tell a trusted adult before using the device for anything important.",
    ],
  },
  {
    id: "social-compromised",
    icon: "👥",
    title: "Social account compromised",
    steps: [
      "Log out of all sessions from the app's security settings.",
      "Reset the password and enable 2FA.",
      "Check DM history — the attacker may have messaged your contacts.",
      "Post a quick note so friends know your account was compromised.",
      "Report the takeover to the platform.",
    ],
  },
  {
    id: "online-threat",
    icon: "⚠️",
    title: "Online threat / blackmail",
    steps: [
      "This is never your fault. Threats and blackmail are illegal.",
      "Do NOT pay, send photos, or keep it a secret.",
      "Stop replying. Save the evidence (screenshots).",
      "Tell a trusted adult or a school counsellor TODAY.",
      "If you feel unsafe, contact local emergency services.",
    ],
  },
  {
    id: "info-exposed",
    icon: "🪪",
    title: "Personal information exposed",
    steps: [
      "Figure out what was exposed: address, ID, photos, school?",
      "Tell a trusted adult.",
      "Change passwords on accounts linked to that information.",
      "If an ID document was shared, report it to the official reporting organisation.",
      "Watch for odd messages — scammers use leaked info to sound convincing.",
    ],
  },
];

export default function EmergencyPage() {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-40 border-b border-amber-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-4xl items-center justify-between px-4">
          <Logo />
          <Link href="/login"><Button variant="outline" className="!py-2">Sign in for personalised help</Button></Link>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-10">
        <div className="rounded-3xl border border-amber-200 bg-amber-50 p-6 sm:p-8">
          <h1 className="text-2xl font-extrabold text-slate-900 sm:text-3xl">I Need Help Now</h1>
          <p className="mt-2 text-slate-700">
            Something happened online? Pick the closest situation. These are calm, immediate, defensive steps —
            <strong> no judgment, no panic</strong>. Always tell a trusted adult when something serious happened.
          </p>
        </div>

        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {CATEGORIES.map((c) => (
            <Card key={c.id} className="flex flex-col">
              <h2 className="flex items-center gap-2 text-lg font-bold text-slate-900">
                <span aria-hidden="true">{c.icon}</span> {c.title}
              </h2>
              <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-slate-700">
                {c.steps.map((s, i) => <li key={i}>{s}</li>)}
              </ol>
              {c.warning ? <p className="mt-3 text-xs font-semibold text-red-600">{c.warning}</p> : null}
            </Card>
          ))}
        </div>

        <div className="mt-10 rounded-2xl border border-slate-200 bg-white p-6 text-center">
          <h2 className="text-lg font-bold text-slate-900">Not sure which one fits?</h2>
          <p className="mt-1 text-sm text-slate-600">
            Ask the MATRIX AI chat — it will walk you through what to do based on exactly what happened.
          </p>
          <Link href="/login" className="mt-4 inline-block"><Button>Open the AI chat</Button></Link>
        </div>
      </main>
    </div>
  );
}
