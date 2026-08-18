import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDataClient, getCurrentUser } from "@/lib/data";
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
  const db = await getDataClient();
  const user = await getCurrentUser(db);
  if (!user) redirect("/login");

  const [{ data: profile }, { data: settings }, { data: memories }, { data: countries }] = await Promise.all([
    db.from("profiles").select("id, full_name, email, phone, school_name, class_grade, country, date_of_birth").eq("id", user!.id).maybeSingle(),
    db.from("user_security_settings").select("*").eq("user_id", user!.id).maybeSingle(),
    db.from("user_memories").select("id, memory, source, created_at").eq("user_id", user!.id).order("created_at", { ascending: false }),
    db.from("countries").select("id, name").order("name"),
  ]);

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
        <AccountForm
          profile={(profile?.data ?? profile) as { full_name: string; email: string; phone: string; school_name: string; class_grade: string; country: string; date_of_birth: string } | null}
          countries={(countries?.data ?? countries ?? []) as { id: string; name: string }[]}
        />
      )}
      {tab === "privacy" && (
        <PrivacyPanel
          settings={(settings?.data ?? settings) as { memory_enabled: boolean; chat_history_enabled: boolean } | null}
          memories={(memories?.data ?? memories ?? []) as { id: string; memory: string; source: string; created_at: string }[]}
        />
      )}
      {tab === "security" && <SecurityPanel />}
      {tab === "appearance" && <AppearancePanel />}
      {tab === "notifications" && (
        <NotificationsForm settings={(settings?.data ?? settings) as { notifications_email: boolean; notifications_push: boolean; notifications_security_alerts: boolean } | null} />
      )}
      {tab === "language" && <LanguagePanel />}
    </div>
  );
}
