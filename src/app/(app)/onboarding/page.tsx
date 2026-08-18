import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDataClient, isDemoMode, getCurrentUser } from "@/lib/data";
import { OnboardingClient } from "@/components/onboarding-client";

export const metadata: Metadata = { title: "Onboarding" };

export default async function OnboardingPage() {
  const db = await getDataClient();
  const user = await getCurrentUser(db);
  const demo = isDemoMode();
  if (!user && !demo) redirect("/login");

  const [{ data: profile }, { data: consent }, { data: verification }, { data: countries }] = await Promise.all([
    db.from("profiles").select("id, full_name, date_of_birth, age_verified, school_name, class_grade, country").eq("id", user!.id).maybeSingle(),
    db.from("guardian_consents").select("status, consent_method, guardian_name, guardian_email").eq("user_id", user!.id).maybeSingle(),
    db.from("identity_verifications").select("verification_status, verification_type, created_at, rejection_reason").eq("user_id", user!.id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("countries").select("id, name, consent_required, consent_min_age").order("name"),
  ]);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold text-slate-900 sm:text-3xl">Welcome to MATRIX AI 🎉</h1>
        <p className="mt-1 text-slate-500">
          A few quick steps to set up your safe account. Some steps need a security team review — you can
          still explore the scam library while you wait.
        </p>
      </div>
      <OnboardingClient
        profile={(profile?.data ?? profile) as { full_name: string; date_of_birth: string | null; age_verified: boolean; school_name: string; class_grade: string; country: string } | null}
        consent={(consent?.data ?? consent) as { status: string; consent_method: string } | null}
        verification={(verification?.data ?? verification) as { verification_status: string; rejection_reason: string } | null}
        countries={(countries?.data ?? countries ?? []) as { id: string; name: string; consent_required: boolean; consent_min_age: number }[]}
        emailVerified={Boolean(user?.email_confirmed_at)}
        demo={demo}
      />
    </div>
  );
}
