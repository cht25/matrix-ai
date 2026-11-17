"use client";

// =============================================================================
// QORVYNA native application shell (Tauri Android + Windows).
//
// This file is NOT a second frontend. It mounts the website's own components:
//
//   AppShell      — the website's sidebar / mobile bottom-nav / notifications
//                   bell / theme / dialogs (src/components/app-shell.tsx)
//   ChatClient    — the website's chat surface (composer, models, voice,
//                   artifacts, streaming)
//   DevicesClient, ModelsClient, AutomationsClient, SettingsTabs,
//   NotificationsCenter, Mirror… — the website's screens, unchanged
//
// The only native-specific parts are:
//   • RouterProvider      (src/native/router.tsx)  — history instead of Next
//   • FirstRunSetup       (this file)               — OS permissions checklist
//   • NativeStatus        (this file)               — inspection / wake-word
//
// Everything that touches the account uses the same endpoints as the web app:
// Firebase Auth (REST/persistence) for identity and `/api/rpc` + `/api/ai`
// for data, with the ID token in `Authorization` and the session cookie when
// the webview can hold one.
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, CheckCircle2, ChevronRight, Loader2, Mic, RefreshCw, XCircle } from "lucide-react";
import { AuthShell, AuthUnavailable, LoginForm } from "@/components/auth/login-screen";
import { AppShell } from "@/components/app-shell";
import { ChatClient } from "@/components/chat-client";
import { DevicesClient } from "@/components/devices/devices-client";
import { ModelsClient } from "@/components/models-client";
import { AutomationsClient } from "@/components/automations-client";
import { NotificationsCenter } from "@/components/notifications/notifications-center";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { AccountForm } from "@/components/settings/account-form";
import { PrivacyPanel } from "@/components/settings/privacy-panel";
import { SecurityPanel } from "@/components/settings/security-panel";
import { NotificationsForm } from "@/components/settings/notifications-form";
import { AppearancePanel } from "@/components/settings/appearance-panel";
import { LanguagePanel } from "@/components/settings/language-panel";
import { GithubConnection } from "@/components/github-connection";
import { DashboardView } from "@/components/dashboard/dashboard-view";
import { HistorySearch } from "@/components/history-search";
import { OnboardingClient } from "@/components/onboarding-client";
import { CompareClient } from "@/components/compare-client";
import { CanvasClient } from "@/components/canvas-client";
import { JarvisAssistantBar } from "@/components/voice/jarvis-assistant-bar";
import { NativeAssistantPanel } from "@/components/voice/native-assistant-panel";
import { ToastProvider } from "@/components/toast";
import { useAuthLifecycle } from "@/components/auth/auth-provider";
import { markSessionEstablished } from "@/lib/auth/lifecycle";
import { fbAuth, firebaseBrowserConfigured, waitForAuthUser } from "@/lib/firebase/client";
import { completeAuthenticatedSession, postAuthPath } from "@/lib/auth/oauth";
import { rpc } from "@/lib/client/api";
import { Logo } from "@/components/logo";
import { Button, Card, Spinner } from "@/components/ui";
import { cn } from "@/lib/utils";
import { RouterProvider, usePathname, useRouter, useSearchParams, parseHref } from "@/native/router";
import {
  PERMISSION_CATALOG,
  assistantState,
  isNativeShell,
  permissionStatus,
  requestPermission,
  openPermissionSettings,
  type AssistantState,
  type PermissionStatus,
  onDeepLink,
  takePendingAssistantTurn,
} from "@/native/native-bridge";
import type { SidebarConversation } from "@/lib/chat-utils";
import type { ChatMessage } from "@/components/chat-client";

// ---------------------------------------------------------------------------
// Routes that require a backend session (mirrors src/middleware.ts)
// ---------------------------------------------------------------------------

const PUBLIC_ROUTES = ["/", "/login", "/register", "/forgot-password", "/reset-password", "/offline", "/privacy", "/terms", "/support"];
const AUTH_ROUTES = ["/login", "/register", "/forgot-password", "/reset-password"];

function matches(path: string, route: string): boolean {
  if (route === "/") return path === "/";
  return path === route || path.startsWith(`${route}/`);
}

/** Which screen the URL names. Unknown routes get an honest 404 card. */
type Screen =
  | { kind: "home" }
  | { kind: "chat"; conversationId: string | null }
  | { kind: "devices" }
  | { kind: "models" }
  | { kind: "automations" }
  | { kind: "notifications" }
  | { kind: "settings" }
  | { kind: "dashboard" }
  | { kind: "history" }
  | { kind: "onboarding" }
  | { kind: "compare" }
  | { kind: "canvas" }
  | { kind: "not-found" };

function screenFor(pathname: string): Screen {
  if (pathname === "/" || pathname === "") return { kind: "home" };
  if (pathname === "/chat") return { kind: "chat", conversationId: null };
  const chat = /^\/chat\/([^/]+)\/?$/.exec(pathname);
  if (chat) return { kind: "chat", conversationId: decodeURIComponent(chat[1]) };
  if (matches(pathname, "/devices")) return { kind: "devices" };
  if (matches(pathname, "/models")) return { kind: "models" };
  if (matches(pathname, "/automations")) return { kind: "automations" };
  if (matches(pathname, "/notifications")) return { kind: "notifications" };
  if (matches(pathname, "/settings")) return { kind: "settings" };
  if (matches(pathname, "/dashboard")) return { kind: "dashboard" };
  if (matches(pathname, "/history")) return { kind: "history" };
  if (matches(pathname, "/onboarding")) return { kind: "onboarding" };
  if (matches(pathname, "/compare")) return { kind: "compare" };
  if (matches(pathname, "/canvas")) return { kind: "canvas" };
  return { kind: "not-found" };
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

/**
 * Applies `qorvyna://` deep links to the router. Mounted inside the
 * RouterProvider so it can navigate. Pairing links open the Devices screen with
 * the code pre-filled; `qorvyna://voice` triggers the Jarvis bar; everything
 * else navigates. Unknown schemes are ignored (parseDeepLink returns
 * `unknown`) so a hostile link cannot steer the app anywhere.
 */
function DeepLinkBridge() {
  const router = useRouter();
  useEffect(() => {
    return onDeepLink((intent) => {
      if (intent.kind === "pair") {
        router.push(`/devices?link=${encodeURIComponent(intent.token)}`);
        return;
      }
      if (intent.kind === "voice") {
        window.dispatchEvent(new CustomEvent("qorvyna://voice-activate"));
        return;
      }
      if (intent.kind === "navigate") {
        const safe = parseHref(intent.path);
        router.push(`${safe.pathname}${safe.search ? `?${safe.search}` : ""}`);
      }
    });
  }, [router]);
  return null;
}

/**
 * Android hands a turn to the app in two steps: the service marks a "pending"
 * flag while the app is in the background, then brings the app forward. This
 * consumes that flag exactly once — on mount and whenever the app becomes
 * visible — and starts a voice turn through the same event the hotkey uses.
 * The flag is cleared by the Rust side on read, so a wake phrase can never
 * start two turns.
 */
function AssistantWakeBridge() {
  useEffect(() => {
    if (!isNativeShell()) return;
    let disposed = false;
    const consume = async () => {
      const pending = await takePendingAssistantTurn();
      if (disposed || !pending) return;
      window.dispatchEvent(new CustomEvent("qorvyna://voice-activate"));
    };
    void consume();
    const onForeground = () => {
      if (document.visibilityState === "visible") void consume();
    };
    document.addEventListener("visibilitychange", onForeground);
    window.addEventListener("focus", onForeground);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onForeground);
      window.removeEventListener("focus", onForeground);
    };
  }, []);
  return null;
}

export function NativeApp({ startPath = "/chat" }: { startPath?: string }) {
  const initial = parseHref(startPath);
  return (
    <RouterProvider initialPath={`${initial.pathname}${initial.search ? `?${initial.search}` : ""}`}>
      <ToastProvider>
        <DeepLinkBridge />
        <AssistantWakeBridge />
        <NativeGate />
      </ToastProvider>
    </RouterProvider>
  );
}

// ---------------------------------------------------------------------------
// Auth gate — identical contract to the website: Firebase first, backend
// session verified second, and a login screen when there is no session.
// ---------------------------------------------------------------------------

function NativeGate() {
  const pathname = usePathname();
  const router = useRouter();
  const { status, decision, error } = useAuthLifecycle();

  const requiresAuth = !PUBLIC_ROUTES.some((route) => matches(pathname, route));
  const onAuthPage = AUTH_ROUTES.some((route) => matches(pathname, route));

  // Signed in on an auth page → enter the app, exactly like the website.
  useEffect(() => {
    if (status === "READY" && onAuthPage) router.replace("/chat");
  }, [status, onAuthPage, router]);

  if (!firebaseBrowserConfigured) return <AuthUnavailable />;

  if (requiresAuth && status !== "READY") {
    if (status === "ERROR") {
      return (
        <AuthShell title="QORVYNA could not start">
          <div className="space-y-3">
            <p className="text-[13px] leading-relaxed text-ink-2">{error?.message ?? "Authentication could not be initialised."}</p>
            <Button type="button" className="w-full" onClick={() => window.location.reload()}>
              Try again
            </Button>
          </div>
        </AuthShell>
      );
    }
    if (status === "UNAUTHENTICATED" || status === "AUTHENTICATED") {
      return (
        <AuthShell>
          <LoginForm />
        </AuthShell>
      );
    }
    return <NativeSplash label="Restoring your QORVYNA session…" />;
  }

  return <NativeWorkspace />;
}

function NativeSplash({ label }: { label: string }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6">
      <Logo />
      <div className="flex items-center gap-2 text-[13px] text-ink-2">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        {label}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workspace — the website's AppShell with the website's screens inside
// ---------------------------------------------------------------------------

function NativeWorkspace() {
  const pathname = usePathname();
  const search = useSearchParams();
  const [identity, setIdentity] = useState<{ email: string; fullName: string; avatarUrl?: string } | null>(null);
  const [conversations, setConversations] = useState<SidebarConversation[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);

  // Identity + sidebar come from the same RPC the web server component uses.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const user = fbAuth().currentUser ?? (await waitForAuthUser(2500));
      if (!user) return;
      if (!cancelled) {
        setIdentity({
          email: user.email ?? "",
          fullName: user.displayName || (user.email?.split("@")[0] ?? "QORVYNA user"),
          avatarUrl: user.photoURL ?? undefined,
        });
      }
      try {
        const profile = await rpc<{ full_name?: string; avatar_url?: string; is_admin?: boolean }>("profile_get").catch(() => null);
        if (cancelled) return;
        if (profile?.full_name || profile?.avatar_url) {
          setIdentity((prev) => ({
            email: user.email ?? "",
            fullName: profile?.full_name || prev?.fullName || "QORVYNA user",
            avatarUrl: profile?.avatar_url || prev?.avatarUrl,
          }));
        }
        if (profile?.is_admin) setIsAdmin(true);
      } catch {
        /* the shell renders without a profile rather than failing */
      }
      try {
        const list = await rpc<{ conversations?: SidebarConversation[] }>("conversation_list").catch(() => null);
        if (!cancelled && Array.isArray(list?.conversations)) setConversations(list.conversations);
      } catch {
        /* an empty history is honest; the chat still works */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // First launch on a native build → the permission checklist (Phase 3).
  useEffect(() => {
    if (!isNativeShell()) return;
    try {
      if (window.localStorage.getItem("qorvyna.native.setup-complete") !== "1") setSetupOpen(true);
    } catch {
      setSetupOpen(true);
    }
  }, []);

  const screen = useMemo(() => screenFor(pathname), [pathname]);
  const user = identity ?? { email: "", fullName: "QORVYNA user" };

  return (
    <AppShell user={user} conversations={conversations} isAdmin={isAdmin} sidebarError={null} renderedAt={new Date().toISOString()}>
      <div className="flex min-h-0 flex-1 flex-col">
        <ScreenContent screen={screen} search={search} />
      </div>
      {setupOpen ? <FirstRunSetup onClose={() => setSetupOpen(false)} /> : null}
      <NativeRefreshHint />
    </AppShell>
  );
}

function ScreenContent({ screen, search }: { screen: Screen; search: URLSearchParams }) {
  switch (screen.kind) {
    case "home":
    case "chat":
      return <NativeChat conversationId={screen.kind === "chat" ? screen.conversationId : null} search={search} />;
    case "devices":
      return <DevicesClient />;
    case "models":
      return <ModelsClient />;
    case "automations":
      return <AutomationsClient />;
    case "notifications":
      return <NotificationsCenter />;
    case "settings":
      return <NativeSettings tab={search.get("tab") ?? "account"} />;
    case "dashboard":
      return <NativeDashboard />;
    case "history":
      return <NativeHistory />;
    case "onboarding":
      return <NativeOnboarding />;
    case "compare":
      return <CompareClient />;
    case "canvas":
      return <NativeCanvas />;
    default:
      return <NativeNotFound />;
  }
}

/**
 * The chat page. `ChatClient` is the website's component; this wrapper only
 * loads the conversation the URL names (the web server component does the same
 * read) and hands it the same props.
 */
function NativeChat({ conversationId, search }: { conversationId: string | null; search: URLSearchParams }) {
  const [messages, setMessages] = useState<ChatMessage[] | null>(conversationId ? null : []);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const mode = search.get("mode") ?? "general";

  useEffect(() => {
    if (!conversationId) {
      setMessages([]);
      setTitle(null);
      return;
    }
    let cancelled = false;
    setMessages(null);
    setLoadError(null);
    void rpc<{ messages?: ChatMessage[]; conversation?: { title?: string } }>("conversation_get", { conversation_id: conversationId })
      .then((data) => {
        if (cancelled) return;
        setMessages(Array.isArray(data?.messages) ? data.messages : []);
        setTitle(data?.conversation?.title ?? null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setMessages([]);
        setLoadError(error instanceof Error ? error.message : "This conversation could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  if (messages === null) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-ink-2">
        <Spinner /> Loading conversation…
      </div>
    );
  }
  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-1 flex-col">
      {loadError ? (
        <div className="mx-4 mt-3 flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[12.5px] text-ink">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          {loadError}
        </div>
      ) : null}
      <ChatClient
        key={conversationId ?? `home-${mode}`}
        initialMessages={messages}
        conversationId={conversationId}
        isTemporary={false}
        initialMode={mode as never}
        initialTitle={title ?? undefined}
      />
    </div>
  );
}

function NativeNotFound() {
  const router = useRouter();
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Card className="max-w-sm p-6 text-center">
        <h1 className="text-base font-semibold text-ink">This screen is not in the app</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
          The page you opened does not exist in this build. Nothing was lost — go back to chat or your devices.
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Button type="button" onClick={() => router.push("/chat")}>Open chat</Button>
          <Button type="button" variant="outline" onClick={() => router.push("/devices")}>Devices</Button>
        </div>
      </Card>
    </div>
  );
}

function NativeRefreshHint() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onOffline = () => setShow(true);
    const onOnline = () => setShow(false);
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    setShow(!navigator.onLine);
    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, []);
  if (!show) return null;
  return (
    <div className="fixed inset-x-0 bottom-16 z-50 mx-auto flex w-fit items-center gap-2 rounded-full border border-warning/40 bg-surface px-3 py-1.5 text-[12px] text-ink shadow-[var(--shadow-pop)]">
      <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Offline — cached work stays available
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 3 — first-run setup checklist
// ---------------------------------------------------------------------------

const STATE_LABEL: Record<PermissionStatus["state"], string> = {
  granted: "Granted",
  denied: "Denied",
  not_requested: "Not requested",
  unsupported: "Not available here",
  restricted: "Restricted by the system",
};

function FirstRunSetup({ onClose }: { onClose: () => void }) {
  const [statuses, setStatuses] = useState<PermissionStatus[] | null>(null);
  const [assistant, setAssistant] = useState<AssistantState | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const doneRef = useRef(false);

  const load = useCallback(async () => {
    const [next, state] = await Promise.all([permissionStatus(), assistantState().catch(() => null)]);
    setStatuses(next);
    setAssistant(state);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const finish = () => {
    if (!doneRef.current) {
      doneRef.current = true;
      try {
        window.localStorage.setItem("qorvyna.native.setup-complete", "1");
      } catch {
        /* private storage: ask again next launch */
      }
    }
    onClose();
  };

  const required = PERMISSION_CATALOG.filter((permission) => permission.required);

  return (
    <div className="fixed inset-0 z-[120] flex flex-col bg-bg/95 backdrop-blur-sm">
      <div className="mx-auto flex w-full max-w-lg flex-1 flex-col overflow-y-auto px-4 py-6">
        <div className="flex items-center justify-between">
          <Logo />
          <button type="button" className="text-[12.5px] font-medium text-ink-2" onClick={finish}>
            Skip for now
          </button>
        </div>
        <h1 className="mt-6 text-lg font-semibold text-ink">Set up QORVYNA on this device</h1>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
          Chat works with none of these. Each is requested only when you choose it, and you can change any of them later in
          Settings.
        </p>

        {required.length > 0 ? (
          <p className="mt-4 rounded-lg border border-border bg-surface-2 px-3 py-2 text-[12.5px] text-ink-2">
            {required.length} item{required.length === 1 ? " is" : "s are"} required for the features you turned on; everything else is optional.
          </p>
        ) : null}

        <ul className="mt-4 space-y-2">
          {PERMISSION_CATALOG.map((permission) => {
            const status = statuses?.find((entry) => entry.id === permission.id);
            const state = status?.state ?? "not_requested";
            return (
              <li key={permission.id} className="rounded-xl border border-border bg-surface p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13.5px] font-medium text-ink">{permission.label}</span>
                      <span className={cn(
                        "rounded-full px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide",
                        permission.required ? "bg-accent/15 text-accent" : "bg-surface-2 text-ink-3",
                      )}>
                        {permission.required ? "Required" : "Optional"}
                      </span>
                      <span className={cn(
                        "rounded-full px-1.5 py-0.5 text-[10.5px] font-medium",
                        state === "granted" ? "bg-success/15 text-success" : state === "denied" ? "bg-danger/15 text-danger" : "bg-surface-2 text-ink-3",
                      )}>
                        {state === "granted" ? <CheckCircle2 className="mr-1 inline h-3 w-3" aria-hidden="true" /> : state === "denied" ? <XCircle className="mr-1 inline h-3 w-3" aria-hidden="true" /> : null}
                        {STATE_LABEL[state]}
                      </span>
                    </div>
                    <p className="mt-1 text-[12px] leading-relaxed text-ink-2">{permission.why}</p>
                    {status?.detail ? <p className="mt-1 text-[11px] text-ink-3">{status.detail}</p> : null}
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {state === "granted" ? null : (
                    <Button
                      type="button"
                      variant="outline"
                      className="btn-sm"
                      disabled={busyId !== null || state === "unsupported"}
                      onClick={async () => {
                        setBusyId(permission.id);
                        try {
                          await requestPermission(permission.id);
                          await load();
                        } finally {
                          setBusyId(null);
                        }
                      }}
                    >
                      {busyId === permission.id ? <Spinner /> : <Mic className="h-3.5 w-3.5" aria-hidden="true" />} Allow
                    </Button>
                  )}
                  {(state === "denied" || state === "restricted") ? (
                    <Button type="button" variant="ghost" className="btn-sm" onClick={() => void openPermissionSettings(permission.id)}>
                      Open system settings
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>

        {assistant ? (
          <div className="mt-4 rounded-xl border border-border bg-surface p-3">
            <div className="flex items-center gap-2 text-[13.5px] font-medium text-ink">
              <Mic className="h-4 w-4" aria-hidden="true" /> “Hey QORVYNA” and the assistant bubble
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-2">{assistant.note}</p>
            <ul className="mt-2 space-y-1 text-[12px] text-ink-2">
              <li>
                Wake word on this device:{" "}
                <strong>
                  {assistant.wakeWordSupported
                    ? assistant.wakeWordEnabled
                      ? `enrolled (${assistant.wakeSamples}/${assistant.wakeRequired}) and listening`
                      : "enrolled but switched off"
                    : `${assistant.wakeSamples}/${assistant.wakeRequired} samples — not ready`}
                </strong>
              </li>
              <li>
                Floating assistant:{" "}
                <strong>{assistant.platform === "android"
                  ? assistant.overlaySupported
                    ? "bubble allowed"
                    : "needs “Display over other apps”"
                  : "Ctrl+Shift+Space popup"}</strong>
              </li>
              <li>Default assistant: <strong>{assistant.defaultAssistant ? "QORVYNA" : "not set"}</strong></li>
            </ul>
            <p className="mt-2 text-[11px] text-ink-3">
              Matching runs on this device against the phrase you recorded; audio never leaves the phone for it.
              The microphone only opens for a turn, or while the enrolled phrase is being listened for.
            </p>
            <div className="mt-3">
              <NativeAssistantPanel />
            </div>
          </div>
        ) : null}

        <div className="sticky bottom-0 mt-6 flex gap-2 bg-bg py-3">
          <Button type="button" className="flex-1" onClick={() => void load()}>
            Re-check
          </Button>
          <Button type="button" variant="outline" className="flex-1" onClick={finish}>
            Start using QORVYNA
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screens whose data the web server component loads — the SAME component is
// rendered here, with the same data fetched from the same RPC actions.
// ---------------------------------------------------------------------------

type SettingsData = {
  profile: { id: string; full_name: string; email: string; phone: string; school_name: string; class_grade: string; country: string; date_of_birth: string; avatar_url: string } | null;
  settings: {
    memory_enabled: boolean; chat_history_enabled: boolean; notifications_email: boolean; notifications_push: boolean;
    notifications_security_alerts: boolean; data_export_requested_at: string | null; deletion_requested_at: string | null;
  } | null;
  countries: Array<{ id: string; name: string }>;
};

const SETTINGS_TABS = [
  { id: "account", label: "Account" },
  { id: "security", label: "Security" },
  { id: "privacy", label: "Privacy" },
  { id: "appearance", label: "Appearance" },
  { id: "notifications", label: "Notifications" },
  { id: "language", label: "Language" },
  { id: "integrations", label: "Integrations" },
];

function NativeSettings({ tab }: { tab: string }) {
  const [data, setData] = useState<SettingsData | null>(null);
  useEffect(() => {
    let cancelled = false;
    void rpc<SettingsData>("settings_get")
      .catch(() => rpc<SettingsData>("profile_get").then((profile) => ({ profile: (profile as unknown as SettingsData["profile"]) ?? null, settings: null, countries: [] })).catch(() => ({ profile: null, settings: null, countries: [] })))
      .then((next) => {
        if (!cancelled) setData(next);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  if (!data) return <ScreenLoading label="Loading settings…" />;
  const profile = data.profile
    ? {
        id: data.profile.id ?? "",
        full_name: data.profile.full_name ?? "",
        email: data.profile.email ?? "",
        phone: data.profile.phone ?? "",
        school_name: data.profile.school_name ?? "",
        class_grade: data.profile.class_grade ?? "",
        country: data.profile.country ?? "",
        date_of_birth: data.profile.date_of_birth ?? "",
        avatar_url: data.profile.avatar_url ?? "",
      }
    : null;
  const settings = {
    memory_enabled: data.settings?.memory_enabled ?? true,
    chat_history_enabled: data.settings?.chat_history_enabled ?? true,
    notifications_email: data.settings?.notifications_email ?? true,
    notifications_push: data.settings?.notifications_push ?? false,
    notifications_security_alerts: data.settings?.notifications_security_alerts ?? true,
    data_export_requested_at: data.settings?.data_export_requested_at ?? null,
    deletion_requested_at: data.settings?.deletion_requested_at ?? null,
  };
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-1 py-2">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">Settings</h1>
        <p className="mt-1 text-ink-2">Manage your account, security, privacy, appearance and notifications.</p>
      </div>
      <SettingsTabs tabs={SETTINGS_TABS} active={tab} />
      {tab === "account" && <AccountForm profile={profile} countries={data.countries ?? []} />}
      {tab === "privacy" && <PrivacyPanel settings={settings} memories={[]} />}
      {tab === "security" && <SecurityPanel />}
      {tab === "appearance" && <AppearancePanel />}
      {tab === "notifications" && <NotificationsForm settings={settings} />}
      {tab === "language" && <LanguagePanel />}
      {tab === "integrations" && <GithubConnection />}
    </div>
  );
}

function NativeHistory() {
  const [conversations, setConversations] = useState<Array<{ id: string; title: string; summary: string; created_at: string; updated_at: string; archived_at: string | null }> | null>(null);
  useEffect(() => {
    let cancelled = false;
    void rpc<{ conversations?: Array<Record<string, string | null>> }>("conversation_list")
      .then((result) => {
        if (cancelled) return;
        setConversations(
          (result?.conversations ?? []).map((row) => ({
            id: String(row.id ?? ""),
            title: String(row.title ?? "Untitled"),
            summary: String(row.summary ?? ""),
            created_at: String(row.created_at ?? ""),
            updated_at: String(row.updated_at ?? row.created_at ?? ""),
            archived_at: (row.archived_at as string | null) ?? null,
          })),
        );
      })
      .catch(() => { if (!cancelled) setConversations([]); });
    return () => { cancelled = true; };
  }, []);
  if (conversations === null) return <ScreenLoading label="Loading history…" />;
  return (
    <div className="space-y-6 px-1 py-2">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">Chat history</h1>
        <p className="mt-1 text-ink-2">Search, archive, export or delete your saved conversations.</p>
      </div>
      {conversations.length === 0 ? (
        <p className="text-[13px] text-ink-2">Your saved conversations will show up here.</p>
      ) : (
        <HistorySearch conversations={conversations} />
      )}
    </div>
  );
}

function NativeCanvas() {
  const [projects, setProjects] = useState<Array<Record<string, unknown>> | null>(null);
  useEffect(() => {
    let cancelled = false;
    void rpc<{ projects?: Array<Record<string, unknown>> }>("project_list")
      .then((result) => { if (!cancelled) setProjects(result?.projects ?? []); })
      .catch(() => { if (!cancelled) setProjects([]); });
    return () => { cancelled = true; };
  }, []);
  if (projects === null) return <ScreenLoading label="Loading canvas…" />;
  return <CanvasClient projects={projects as never} />;
}

function NativeOnboarding() {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    let cancelled = false;
    void rpc<Record<string, unknown>>("onboarding_status")
      .catch(() => null)
      .then((result) => { if (!cancelled) setData(result ?? {}); });
    return () => { cancelled = true; };
  }, []);
  if (!data) return <ScreenLoading label="Loading your profile…" />;
  return (
    <OnboardingClient
      profile={(data.profile as never) ?? null}
      consent={(data.consent as never) ?? null}
      verification={(data.verification as never) ?? null}
      countries={(data.countries as never[]) ?? []}
      emailVerified={data.email_verified === true}
    />
  );
}

function NativeDashboard() {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    let cancelled = false;
    void rpc<Record<string, unknown>>("dashboard_summary")
      .catch(() => null)
      .then((result) => { if (!cancelled) setData(result ?? {}); });
    return () => { cancelled = true; };
  }, []);
  if (!data) return <ScreenLoading label="Loading your dashboard…" />;
  return (
    <DashboardView
      firstName={(data.first_name as string | null) ?? null}
      score={Number(data.score ?? 0)}
      emailConfirmed={data.email_confirmed !== false}
      ageVerified={data.age_verified === true}
      completedLessons={Number(data.completed_lessons ?? 0)}
      certificates={(data.certificates as never[]) ?? []}
      events={(data.events as never[]) ?? []}
      analyses={(data.analyses as never[]) ?? []}
      recommendations={(data.recommendations as never[]) ?? []}
    />
  );
}

function ScreenLoading({ label }: { label: string }) {
  return (
    <div className="flex flex-1 items-center justify-center gap-2 py-10 text-[13px] text-ink-2">
      <Spinner /> {label}
    </div>
  );
}

export { PERMISSION_CATALOG };
