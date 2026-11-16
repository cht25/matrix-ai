import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/chat",
  useSearchParams: () => new URLSearchParams(),
}));

import { ThemeProvider } from "../src/lib/theme";
import { LocaleProvider } from "../src/lib/i18n/client";
import { AuthLifecycleProvider } from "../src/components/auth/auth-provider";
import { AppShell } from "../src/components/app-shell";
import { ChatClient } from "../src/components/chat-client";
import { DashboardView } from "../src/components/dashboard/dashboard-view";
import { OnboardingClient } from "../src/components/onboarding-client";
import { HistorySearch } from "../src/components/history-search";
import { ActivityDisclosure } from "../src/components/activity-panel";
import { DeviceHub } from "../src/components/devices/device-hub";
import { ToastProvider } from "../src/components/toast";
import { BuildRunCard } from "../src/components/build/build-run-card";
import { DeploymentHistory, DeploymentPanel } from "../src/components/build/deployment-panel";
import { PipelineAnalyticsPanel } from "../src/components/pipeline-analytics";
import { AiStatus } from "../src/components/ai-status";
import { NotificationsBell } from "../src/components/notifications-bell";
import { publishCache } from "../src/lib/client/cache";
import { formatDate } from "../src/lib/utils";
import { groupConversationsUtc, type SidebarConversation } from "../src/lib/chat-utils";
import { absoluteUrl } from "../src/lib/deploy/format";
import { runFromSnapshot } from "../src/lib/deploy/stages";
import { activityLines, emptyExecution, startExecution } from "../src/lib/ai/artifacts";
import type { ChatMessage } from "../src/lib/chat-messages";
import type { ProjectDeploymentOverview } from "../src/lib/deploy/provider";

function wrapProviders(child: ReactNode) {
  return createElement(
    ThemeProvider,
    null,
    createElement(
      LocaleProvider,
      null,
      createElement(AuthLifecycleProvider, null, child),
    ),
  );
}

const SAMPLE_CONVERSATIONS: SidebarConversation[] = [
  {
    id: "conv-1",
    title: "Cross-midnight chat",
    summary: "",
    // 2026-11-16T20:15:00.000Z -> Nov 16 in UTC, Nov 17 02:15 AM in Asia/Dhaka
    updated_at: "2026-11-16T20:15:00.000Z",
    is_temporary: false,
    mode: "general",
    archived_at: null,
  },
  {
    id: "conv-2",
    title: "Earlier today chat",
    summary: "",
    updated_at: "2026-11-16T14:30:00.000Z",
    is_temporary: false,
    mode: "agent",
    archived_at: null,
  },
];

const SAMPLE_MESSAGES: ChatMessage[] = [
  {
    id: "m1",
    role: "user",
    content: "Build a landing page",
    created_at: "2026-11-16T20:15:00.000Z",
  },
  {
    id: "m2",
    role: "assistant",
    content: "Done! Your landing page is live.",
    created_at: "2026-11-16T20:15:05.000Z",
    metadata: {
      mode: "agent",
      build: {
        run_id: "run-1",
        status: "succeeded",
        project_id: "proj-1",
        project_title: "Landing",
        conversation_id: "conv-2",
        task_id: null,
        stage_states: [
          ["plan", "completed"],
          ["generate", "completed"],
          ["validate", "completed"],
          ["publish", "completed"],
        ],
        workspace_only: false,
        deployment_status: "live",
        url: "/s/my-site",
        environment: "production",
        file_count: 3,
        attempts: 0,
        error_code: null,
      },
    },
  },
];

const SAMPLE_OVERVIEW: ProjectDeploymentOverview = {
  status: "live",
  status_label: "Live",
  status_detail: "Serving traffic",
  environment: "production",
  live_slug: "my-site",
  live_url: "/s/my-site",
  preview_url: "/api/projects/proj-1/preview/index.html",
  project_id: "proj-1",
  files: 3,
  urls: [
    {
      id: "url-1",
      url: "/s/my-site",
      slug: "my-site",
      hostname: "qorvyna.thamjj13.top",
      detail: "",
      kind: "generated",
      primary: true,
      status: "active",
      created_at: "2026-11-16T20:15:00.000Z",
    },
  ],
  deployments: [
    {
      id: "dep-1",
      status: "live",
      slug: "my-site",
      public_url: "/s/my-site",
      error: "",
      log: [{ at: "2026-11-16T20:15:00.000Z", step: "activate", detail: "Live" }],
      created_at: "2026-11-16T20:15:00.000Z",
      files: 3,
      bytes: 2048,
      version: 1,
      environment: "production",
      rollback_available: false,
      overridden: false,
    },
  ],
  capabilities: {
    providerId: "qorvyna",
    label: "QORVYNA hosting",
    environments: [{ id: "production", label: "Production", supported: true, note: "Live" }],
    aliases: true,
    customDomain: "none",
    rollback: false,
    logs: true,
    runsBundler: false,
    serverRuntime: false,
    publishRatePerHour: 10,
  },
  custom_domain: "",
  custom_domain_status: "none",
  last_deployed_at: "2026-11-16T20:15:00.000Z",
  is_live: true,
  hosting_configured: true,
};

describe("SSR / hydration parity", () => {
  it("pins formatDate to UTC regardless of boundary timestamps", () => {
    expect(formatDate("2026-11-16T20:15:00.000Z")).toBe("16 Nov 2026");
    expect(formatDate("2026-11-16T00:01:00.000Z")).toBe("16 Nov 2026");
  });

  it("groups conversations deterministically in UTC via groupConversationsUtc", () => {
    const groups = groupConversationsUtc(SAMPLE_CONVERSATIONS, new Date("2026-11-16T23:50:00.000Z"));
    expect(groups.today.map((c) => c.id)).toEqual(["conv-1", "conv-2"]);
  });

  it("supports empty origin override in absoluteUrl for deterministic pre-hydration hrefs", () => {
    expect(absoluteUrl("/s/my-site", "")).toBe("/s/my-site");
  });

  it("keeps runFromSnapshot(..., 0) and activityLines pure without reading Date.now()", () => {
    const snapshot = SAMPLE_MESSAGES[1].metadata!.build!;
    const a = runFromSnapshot(snapshot, 0);
    const b = runFromSnapshot(snapshot, 0);
    expect(a).toEqual(b);
    expect(a.startedAt).toBe(0);

    const exec = startExecution(emptyExecution());
    const linesA = activityLines(exec);
    const linesB = activityLines(exec);
    expect(linesA).toEqual(linesB);
    expect(linesA[0]?.at).toBe(exec.startedAt);
  });

  it("renders pre-hydration SSR markup without browser timezone, age, UA, or cache drift", () => {
    // Pre-seed client memory caches to prove initial SSR/hydration render ignores them until mounted.
    publishCache("qorvyna:ai-status:v1", "online", 60_000);
    publishCache("qorvyna:notifications:v1", [{ id: "n1", title: "Unread", body: "Notice", read: false, created_at: "2026-11-16T20:15:00.000Z" }], 60_000);

    const appHtml = renderToString(
      wrapProviders(
        createElement(AppShell, {
          user: { email: "test@example.com", fullName: "Test User", avatarUrl: "" },
          conversations: SAMPLE_CONVERSATIONS,
          isAdmin: false,
          renderedAt: "2026-11-16T23:00:00.000Z",
          children: createElement(ChatClient, {
            initialMessages: SAMPLE_MESSAGES,
            conversationId: "conv-2",
            isTemporary: false,
            initialMode: "agent",
          }),
        }),
      ),
    );
    // Must not bake locale clock strings (e.g. "08:15 PM" / "02:15 AM") into SSR/pre-hydration markup
    expect(appHtml).not.toMatch(/\b0?[28]:15\s*[AP]M\b/i);
    // Sidebar groups deterministically in UTC via renderedAt
    expect(appHtml).toContain("Today");

    const dashboardHtml = renderToString(
      wrapProviders(
        createElement(DashboardView, {
          firstName: "Test",
          score: 70,
          emailConfirmed: true,
          ageVerified: false,
          completedLessons: 2,
          certificates: [{ id: "c1", certificate_id: "MTRX-1", issued_at: "2026-11-16T20:15:00.000Z" }],
          events: [{ event_type: "login", created_at: "2026-11-16T20:15:00.000Z" }],
          analyses: [{ risk_level: "low", created_at: "2026-11-16T20:15:00.000Z" }],
          recommendations: [{ text: "Rec 1", href: "/courses", cta: "Go" }],
        }),
      ),
    );
    expect(dashboardHtml).toContain("16 Nov 2026");
    expect(dashboardHtml).not.toContain("17 Nov 2026");
    expect(dashboardHtml).not.toContain("just now");

    const onboardingHtml = renderToString(
      wrapProviders(
        createElement(OnboardingClient, {
          profile: {
            full_name: "Test User",
            date_of_birth: "2012-11-17",
            age_verified: false,
            school_name: "",
            class_grade: "",
            country: "BD",
          },
          consent: null,
          verification: null,
          countries: [{ id: "BD", name: "Bangladesh", consent_required: true, consent_min_age: 18 }],
          emailVerified: true,
        }),
      ),
    );
    expect(onboardingHtml).not.toContain("Age calculated:");

    const historyHtml = renderToString(
      wrapProviders(
        createElement(HistorySearch, {
          conversations: SAMPLE_CONVERSATIONS.map((c) => ({ ...c, created_at: c.updated_at })),
        }),
      ),
    );
    expect(historyHtml).toContain("16 Nov 2026");
    expect(historyHtml).not.toContain("just now");

    const deviceHtml = renderToString(
      wrapProviders(createElement(ToastProvider, null, createElement(DeviceHub))),
    );
    expect(deviceHtml).not.toContain("Chrome");
    expect(deviceHtml).not.toContain("Node");

    const deployHtml = renderToString(
      wrapProviders(
        createElement("div", null, [
          createElement(BuildRunCard, {
            key: "b",
            snapshot: SAMPLE_MESSAGES[1].metadata!.build!,
            overview: SAMPLE_OVERVIEW,
          }),
          createElement(DeploymentPanel, {
            key: "p",
            projectId: "proj-1",
            overview: SAMPLE_OVERVIEW,
            run: null,
            onRefresh: () => {},
            onDeploy: () => {},
            onPreview: () => {},
            onOpenFiles: () => {},
            onManageUrls: () => {},
          }),
          createElement(DeploymentHistory, {
            key: "h",
            projectId: "proj-1",
            rows: SAMPLE_OVERVIEW.deployments,
            rollbackSupported: false,
            onChanged: () => {},
          }),
        ]),
      ),
    );
    expect(deployHtml).toContain("Nov 16");
    expect(deployHtml).toContain("/s/my-site");

    const analyticsHtml = renderToString(
      createElement(PipelineAnalyticsPanel, {
        compact: true,
        analytics: {
          tokensPerSec: 42,
          totalTokens: 1234,
          totalLatencyMs: 1200,
          inputTokens: 1000,
          outputTokens: 234,
          timeToFirstMs: 300,
          agentSteps: 2,
          toolsExecuted: 1,
          successes: 1,
          failures: 0,
        },
      }),
    );
    expect(analyticsHtml).toContain("1,234");

    const activityHtml = renderToString(
      wrapProviders(
        createElement(ActivityDisclosure, {
          execution: {
            status: "complete",
            stage: "complete",
            tool: null,
            analytics: null,
            startedAt: Date.parse("2026-11-16T20:15:00.000Z"),
            finishedAt: Date.parse("2026-11-16T20:15:05.000Z"),
            events: [{ at: Date.parse("2026-11-16T20:15:00.000Z"), type: "stage", message: "Done" }],
          },
        }),
      ),
    );
    expect(activityHtml).toContain("Activity");

    // Pre-warmed caches must NOT leak into SSR / initial client hydrate render
    const bellHtml = renderToString(createElement(NotificationsBell));
    expect(bellHtml).not.toContain(">1<");
    const statusHtml = renderToString(createElement(AiStatus));
    expect(statusHtml).not.toContain("Online");
  });
});
