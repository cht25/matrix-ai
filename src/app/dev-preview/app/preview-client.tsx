"use client";

// DEV-ONLY. The real AppShell and DashboardView with sample data, followed by
// the shared primitives (buttons, fields, cards, badges, alerts, empty and
// error states, dialogs). Nothing here is reachable in production.

import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { DashboardView } from "@/components/dashboard/dashboard-view";
import { useDialogs } from "@/components/dialogs";
import { TaskOutcomeBadge } from "@/components/build/task-outcome";
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Field, Input, Progress, Select, Skeleton, Spinner, Textarea } from "@/components/ui";
import { TASK_OUTCOME_LABELS, type TaskOutcomeState } from "@/lib/ai/task-outcome";
import type { SidebarConversation } from "@/lib/chat-utils";

const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const CONVERSATIONS: SidebarConversation[] = [
  { id: "c1", title: "Portfolio site: add a pricing page", summary: "", updated_at: ago(12), is_temporary: false, mode: "agent", archived_at: null },
  { id: "c2", title: "Explain how DNS resolution works", summary: "", updated_at: ago(95), is_temporary: false, mode: "general", archived_at: null },
  { id: "c3", title: "ESP32 temperature sensor sketch", summary: "", updated_at: ago(60 * 26), is_temporary: false, mode: "code", archived_at: null },
  { id: "c4", title: "Is this message a scam?", summary: "", updated_at: ago(60 * 24 * 4), is_temporary: false, mode: "general", archived_at: null },
  { id: "c5", title: "Study plan for the networking quiz", summary: "", updated_at: ago(60 * 24 * 20), is_temporary: false, mode: "study", archived_at: null },
];

const OUTCOMES: TaskOutcomeState[] = ["completed", "failed", "blocked", "awaiting_approval", "awaiting_input", "paused", "cancelled", "running"];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      {children}
    </section>
  );
}

function Primitives() {
  const dialogs = useDialogs();
  const [answer, setAnswer] = useState<string>("—");
  return (
    <div className="space-y-8">
      <Section title="Buttons">
        <div className="flex flex-wrap items-center gap-2">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button disabled>Disabled</Button>
          <Button aria-busy="true"><Spinner /> Working</Button>
          <Button variant="outline" className="!min-h-9 text-xs">Small</Button>
        </div>
      </Section>

      <Section title="Fields">
        <Card className="grid gap-4 sm:grid-cols-2">
          <Field label="Project name" htmlFor="p-name" hint="Shown in the sidebar and on the public page.">
            <Input id="p-name" placeholder="My portfolio" />
          </Field>
          <Field label="Visibility" htmlFor="p-vis">
            <Select id="p-vis" defaultValue="private"><option value="private">Private</option><option value="public">Public</option></Select>
          </Field>
          <Field label="Search" htmlFor="p-search">
            <div className="relative">
              <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
              <Input id="p-search" placeholder="Search projects…" className="pl-9" />
            </div>
          </Field>
          <Field label="Read only" htmlFor="p-ro">
            <Input id="p-ro" readOnly value="proj_8f2c41d0" className="bg-bg font-mono text-ink-3" />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Description" htmlFor="p-desc">
              <Textarea id="p-desc" rows={3} placeholder="What is this project for?" />
            </Field>
          </div>
        </Card>
      </Section>

      <Section title="Status">
        <div className="flex flex-wrap items-center gap-2">
          {OUTCOMES.map((state) => <TaskOutcomeBadge key={state} outcome={{ state, label: TASK_OUTCOME_LABELS[state] }} />)}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge>Neutral</Badge>
          <Badge className="border-success/30 bg-success-soft text-success">Verified</Badge>
          <Badge className="border-warning/30 bg-warning-soft text-warning">Pending</Badge>
          <Badge className="border-danger/30 bg-danger-soft text-danger">Suspended</Badge>
          <span className="chip">Chip</span>
          <span className="chip border-success/40 bg-success-soft text-success">Valid certificate</span>
        </div>
        <Progress value={64} />
      </Section>

      <Section title="Messages">
        <div className="grid gap-3 lg:grid-cols-2">
          <Alert>Your session is active on 2 devices.</Alert>
          <Alert tone="success">Two-factor authentication is on.</Alert>
          <Alert tone="warning">Your email address is not verified yet.</Alert>
          <Alert tone="danger">The file could not be saved. Try again.</Alert>
        </div>
      </Section>

      <Section title="Empty, loading and error states">
        <div className="grid gap-4 lg:grid-cols-3">
          <EmptyState title="No projects yet" body="Describe what to build in Agent mode and your first project appears here." action={<Button variant="outline" className="!min-h-9 text-xs">Open the Agent</Button>} />
          <Card className="space-y-3">
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-3/5" />
          </Card>
          <ErrorState title="Projects could not be loaded" detail="The server did not answer in time. Nothing was changed." code="PROJECT_STORAGE_UNAVAILABLE" onRetry={() => undefined} />
        </div>
      </Section>

      <Section title="Dialogs">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={async () => setAnswer(String(await dialogs.confirm({ title: "Delete this conversation?", body: "The conversation and its messages are removed for good.", confirmLabel: "Delete" })))}>Confirm (danger)</Button>
          <Button variant="outline" onClick={async () => setAnswer(String(await dialogs.confirm({ title: "Push 4 files to main?", body: "The reviewed files are committed to your repository.", confirmLabel: "Push", tone: "primary" })))}>Confirm (primary)</Button>
          <Button variant="outline" onClick={async () => setAnswer(String(await dialogs.prompt({ title: "New file", label: "Path", placeholder: "src/index.html" })))}>Prompt</Button>
          <span className="text-xs text-ink-3">Result: <code className="font-mono">{answer}</code></span>
        </div>
        {dialogs.element}
      </Section>
    </div>
  );
}

export function AppPreview() {
  // The sample data is relative to "now", so it is rendered in the browser only.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return (
    <AppShell user={{ email: "alex@qorvyna.test", fullName: "Alex Rahman", avatarUrl: "" }} conversations={CONVERSATIONS} isAdmin={false}>
      <div className="space-y-10">
        <div className="rounded-xl border border-warning/40 bg-warning-soft px-4 py-2 text-[12px] text-warning">
          Development preview — the real application frame and security overview with sample data. Not available in production.
        </div>
        <DashboardView
          firstName="Alex"
          score={64}
          emailConfirmed
          ageVerified={false}
          completedLessons={7}
          certificates={[{ id: "cert-1", certificate_id: "MTRX-CERT-2026-000123", issued_at: ago(60 * 24 * 9) }]}
          events={[
            { event_type: "login", created_at: ago(14) },
            { event_type: "password_changed", created_at: ago(60 * 30) },
            { event_type: "mfa_enabled", created_at: ago(60 * 24 * 6) },
          ]}
          analyses={[{ risk_level: "high", created_at: ago(60 * 5) }, { risk_level: "low", created_at: ago(60 * 24 * 2) }]}
          recommendations={[
            { text: "Add identity details in your profile if you want age verification.", href: "/settings?tab=account", cta: "Edit profile" },
            { text: "Turn on two-factor authentication (2FA) on your accounts.", href: "/settings?tab=security", cta: "Security settings" },
          ]}
        />
        <Primitives />
      </div>
    </AppShell>
  );
}
