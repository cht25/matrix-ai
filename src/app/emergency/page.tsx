import type { Metadata } from "next";
import Link from "next/link";
import {
  AlertTriangle, FileWarning, KeyRound, Link2, Lock, Shield, Smartphone, UserX, Wallet,
} from "lucide-react";
import { Logo } from "@/components/logo";
import { Button, Card } from "@/components/ui";

export const metadata: Metadata = { title: "I Need Help Now" };

type EmergencyCategory = {
  id: string;
  icon: React.ReactNode;
  title: string;
  steps: string[];
};

const CATEGORIES: EmergencyCategory[] = [
  {
    id: "account-hacked",
    icon: <Lock size={17} strokeWidth={1.5} />,
    title: "My account was hacked",
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
    icon: <Link2 size={17} strokeWidth={1.5} />,
    title: "I clicked a suspicious link",
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
    icon: <KeyRound size={17} strokeWidth={1.5} />,
    title: "I shared my OTP / verification code",
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
    icon: <Wallet size={17} strokeWidth={1.5} />,
    title: "I lost money",
    steps: [
      "Tell a trusted adult right away — you are not in trouble.",
      "Contact the bank or payment provider to try to stop the payment.",
      "Keep all evidence: screenshots, receipts, messages.",
      "Do NOT pay any more money, no matter what the scammer promises.",
      "Report to the official reporting organisation for your country.",
    ],
  },
  {
    id: "social-compromised",
    icon: <UserX size={17} strokeWidth={1.5} />,
    title: "My social account was taken over",
    steps: [
      "Log out of all sessions from the app's security settings.",
      "Reset the password and enable 2FA.",
      "Check DM history — the attacker may have messaged your contacts.",
      "Post a quick note so friends know your account was compromised.",
      "Report the takeover to the platform.",
    ],
  },
  {
    id: "malware",
    icon: <Smartphone size={17} strokeWidth={1.5} />,
    title: "I installed suspicious software",
    steps: [
      "Stop using the device for important accounts (email, banking).",
      "Run a reputable security scan.",
      "Remove suspicious apps — especially ones you sideloaded.",
      "Change important passwords from a different device.",
      "Tell a trusted adult before using the device for anything important.",
    ],
  },
  {
    id: "online-threat",
    icon: <AlertTriangle size={17} strokeWidth={1.5} />,
    title: "Someone is threatening me online",
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
    icon: <FileWarning size={17} strokeWidth={1.5} />,
    title: "My personal information was exposed",
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
    <div className="min-h-dvh">
      <header className="sticky top-0 z-40 border-b border-border bg-surface/85 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-4xl items-center justify-between px-4">
          <Logo size="sm" />
          <Link href="/login"><Button variant="outline" className="!min-h-9 !px-3 text-xs">Sign in for personalised help</Button></Link>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-10">
        <div className="border border-border-strong bg-surface p-6 sm:p-8">
          <p className="eyebrow mb-2">MATRIX · Emergency</p>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-ink sm:text-3xl">I Need Help Now</h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-2">
            Something happened online? Pick the closest situation. These are calm, immediate, defensive
            steps — <strong className="text-ink">no judgment, no panic</strong>. Always tell a trusted adult
            when something serious happened.
          </p>
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {CATEGORIES.map((c) => (
            <Card key={c.id} className="flex flex-col !p-6">
              <h2 className="flex items-center gap-3 text-[15px] font-semibold text-ink">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded border border-border-strong text-ink-2" aria-hidden="true">
                  {c.icon}
                </span>
                {c.title}
              </h2>
              <ol className="mt-4 list-decimal space-y-2 pl-5 text-[13.5px] leading-relaxed text-ink-2 marker:font-medium marker:text-ink-3">
                {c.steps.map((s, i) => <li key={i}>{s}</li>)}
              </ol>
            </Card>
          ))}
        </div>

        <div className="mt-10 border border-border bg-surface p-6 text-center">
          <h2 className="text-[15px] font-semibold text-ink">Not sure which one fits?</h2>
          <p className="mt-1 text-sm text-ink-2">Ask MATRIX AI — it will walk you through what to do based on exactly what happened.</p>
          <Link href="/login" className="mt-4 inline-block"><Button>Open the AI chat</Button></Link>
        </div>
      </main>
    </div>
  );
}
