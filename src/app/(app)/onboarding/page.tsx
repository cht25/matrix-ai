import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { getOnboardingData } from "@/lib/server/queries";
import { OnboardingClient } from "@/components/onboarding-client";

export const metadata: Metadata = { title: "Onboarding" };

export default async function OnboardingPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { profile, consent, verification, countries } = await getOnboardingData(db(), user.uid);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">Profile verification</h1>
        <p className="mt-1 text-ink-2">
          Optional identity details for age verification. You can skip this and chat immediately — edit these
          anytime from Settings.
        </p>
      </div>
      <OnboardingClient
        profile={profile}
        consent={consent}
        verification={verification}
        countries={countries}
        emailVerified={user.emailVerified}
      />
    </div>
  );
}
