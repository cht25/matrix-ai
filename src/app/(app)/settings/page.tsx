import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { getSettingsData } from "@/lib/server/queries";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { AccountForm } from "@/components/settings/account-form";
import { PrivacyPanel } from "@/components/settings/privacy-panel";
import { SecurityPanel } from "@/components/settings/security-panel";
import { NotificationsForm } from "@/components/settings/notifications-form";
import { AppearancePanel } from "@/components/settings/appearance-panel";
import { LanguagePanel } from "@/components/settings/language-panel";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab = "account" } = await searchParams;
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { profile, settings, memories, countries } = await getSettingsData(db(), user.uid);

  const tabs = [
    { id: "account", label: "Account" },
    { id: "security", label: "Security" },
    { id: "privacy", label: "Privacy" },
    { id: "appearance", label: "Appearance" },
    { id: "notifications", label: "Notifications" },
    { id: "language", label: "Language" },
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-display font-semibold tracking-tight text-ink sm:text-3xl">Settings</h1>
        <p className="mt-1 text-ink-2">Manage your account, security, privacy, appearance and notifications.</p>
      </div>

      <SettingsTabs tabs={tabs} active={tab} />

      {tab === "account" && (
        <AccountForm profile={profile} countries={countries} />
      )}
      {tab === "privacy" && (
        <PrivacyPanel settings={settings} memories={memories} />
      )}
      {tab === "security" && <SecurityPanel />}
      {tab === "appearance" && <AppearancePanel />}
      {tab === "notifications" && (
        <NotificationsForm settings={settings} />
      )}
      {tab === "language" && <LanguagePanel />}
    </div>
  );
}
