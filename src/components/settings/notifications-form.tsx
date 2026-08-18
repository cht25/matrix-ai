"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import { Alert, Button, Card } from "@/components/ui";

type Settings = { notifications_email: boolean; notifications_push: boolean; notifications_security_alerts: boolean };

function Toggle({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div>
        <p className="font-semibold text-ink">{label}</p>
        <p className="mt-0.5 text-sm text-ink-3">{description}</p>
      </div>
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${checked ? "bg-accent" : "bg-surface-3"}`}
      >
        <span className={`absolute top-1 h-5 w-5 rounded-full bg-surface transition-all ${checked ? "left-6" : "left-1"}`} />
      </button>
    </div>
  );
}

export function NotificationsForm({ settings }: { settings: Settings | null }) {
  const router = useRouter();
  const [email, setEmail] = useState(settings?.notifications_email ?? true);
  const [push, setPush] = useState(settings?.notifications_push ?? false);
  const [alerts, setAlerts] = useState(settings?.notifications_security_alerts ?? true);
  const [msg, setMsg] = useState<string | null>(null);

  async function save() {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { error } = await supabase
      .from("user_security_settings")
      .update({ notifications_email: email, notifications_push: push, notifications_security_alerts: alerts })
      .eq("user_id", user.id);
    if (error) return setMsg(error.message);
    setMsg("Notification preferences saved.");
    router.refresh();
  }

  return (
    <Card>
      <h2 className="font-bold text-ink">Notifications</h2>
      <div className="divide-y divide-border">
        <Toggle label="Email notifications" description="Course milestones, certificates and important updates by email." checked={email} onChange={setEmail} />
        <Toggle label="Push notifications" description="In-app notifications when available on your device." checked={push} onChange={setPush} />
        <Toggle label="Security alerts" description="New logins, password changes and suspicious activity — recommended." checked={alerts} onChange={setAlerts} />
      </div>
      {msg ? <Alert tone="success" >{msg}</Alert> : null}
      <Button onClick={() => void save()} className="mt-4">Save preferences</Button>
      <p className="mt-3 text-xs text-ink-3">
        Email templates never include passwords, verification data or security secrets.
      </p>
    </Card>
  );
}
