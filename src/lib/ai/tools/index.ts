// =============================================================================
// QORVYNA AI — registered tools. Each handler is a thin, ownership-checked
// wrapper over a REAL server module; nothing here is mocked. A tool whose
// integration is not configured returns an honest error — never fake data.
// =============================================================================

import "server-only";
import { z } from "zod";
import type { Db } from "@/lib/firebase/admin";
import type { SessionUser } from "@/lib/firebase/session";
import { RiskTier, toolRegistry, type ToolContext, type ToolResult } from "@/lib/ai/tools/registry";
import { listProjects, getProject } from "@/lib/server/projects";
import { listGithubRepos, getGithubConnection } from "@/lib/server/github";
import { latestBuildRunForProject } from "@/lib/server/build";
import { listDevices } from "@/lib/server/pairing";
import { listHubDevices } from "@/lib/server/device-hub";
import { listFamiliesForUser } from "@/lib/server/family";
import { createReminder, listReminders, queueDeviceCommand } from "@/lib/server/device-actions";
import {
  clearSyncedNotificationHistory,
  dismissSyncedNotification,
  listSyncedNotifications,
} from "@/lib/server/notifications-sync";

function asDb(ctx: ToolContext): Db {
  return ctx.db as Db;
}
function asUser(ctx: ToolContext): SessionUser {
  return { uid: ctx.uid, email: ctx.email, emailVerified: true };
}

// --- projects ---------------------------------------------------------------
toolRegistry.register({
  id: "projects.list",
  description: "List the signed-in user's own QORVYNA projects.",
  category: "projects",
  risk: RiskTier.LOW,
  requiredPermissions: [],
  scopes: ["projects:read"],
  environment: "server",
  timeoutSeconds: 15,
  approvalRequired: false,
  auditRequired: false,
  rateLimitPerMinute: 30,
  modelCallable: true,
  inputSchema: z.object({}),
  handler: async (ctx): Promise<ToolResult> => {
    const projects = await listProjects(asDb(ctx), asUser(ctx));
    return { ok: true, data: { projects }, message: `${projects.length} project(s).` };
  },
});

toolRegistry.register({
  id: "projects.get",
  description: "Get one of the user's projects by id, including its files. Owner-only.",
  category: "projects",
  risk: RiskTier.LOW,
  requiredPermissions: [],
  scopes: ["projects:read"],
  environment: "server",
  timeoutSeconds: 15,
  approvalRequired: false,
  auditRequired: false,
  rateLimitPerMinute: 30,
  modelCallable: true,
  inputSchema: z.object({ project_id: z.string().min(1).max(128) }),
  handler: async (ctx, input: { project_id: string }): Promise<ToolResult> => {
    const project = await getProject(asDb(ctx), asUser(ctx), input.project_id);
    return { ok: true, data: { project } };
  },
});

// --- git --------------------------------------------------------------------
toolRegistry.register({
  id: "github.connection_status",
  description: "Check whether the user has a connected GitHub account. Returns an honest status, never a fabricated one.",
  category: "git",
  risk: RiskTier.LOW,
  requiredPermissions: [],
  scopes: ["github:read"],
  environment: "external-api",
  timeoutSeconds: 10,
  approvalRequired: false,
  auditRequired: false,
  rateLimitPerMinute: 20,
  modelCallable: true,
  inputSchema: z.object({}),
  handler: async (ctx): Promise<ToolResult> => {
    const connection = await getGithubConnection(ctx.uid);
    if (!connection) return { ok: true, data: { connected: false }, message: "GitHub is not connected." };
    return { ok: true, data: { connected: true, login: connection.login } };
  },
});

toolRegistry.register({
  id: "github.list_repos",
  description: "List repositories the user's connected GitHub account can access. Fails honestly when GitHub is not connected.",
  category: "git",
  risk: RiskTier.LOW,
  requiredPermissions: [],
  scopes: ["github:read"],
  environment: "external-api",
  timeoutSeconds: 20,
  approvalRequired: false,
  auditRequired: true,
  rateLimitPerMinute: 20,
  modelCallable: true,
  inputSchema: z.object({ max: z.number().int().min(1).max(100).default(30) }),
  handler: async (ctx, input: { max: number }): Promise<ToolResult> => {
    try {
      const repos = await listGithubRepos(ctx.uid);
      return { ok: true, data: { repositories: repos.slice(0, input.max) }, message: `${repos.length} repo(s) visible.` };
    } catch (err) {
      const message = err instanceof Error ? err.message : "GITHUB_ERROR";
      return { ok: false, error: message === "GITHUB_NOT_CONNECTED" ? "GITHUB_NOT_CONNECTED" : "GITHUB_ERROR" };
    }
  },
});

// --- deployments --------------------------------------------------------------
toolRegistry.register({
  id: "deployments.latest_for_project",
  description: "Get the latest real build/deployment run for one of the user's projects. Owner-only. Never synthesises a status.",
  category: "deploy",
  risk: RiskTier.LOW,
  requiredPermissions: [],
  scopes: ["deployments:read"],
  environment: "server",
  timeoutSeconds: 15,
  approvalRequired: false,
  auditRequired: false,
  rateLimitPerMinute: 30,
  modelCallable: true,
  inputSchema: z.object({ project_id: z.string().min(1).max(128) }),
  handler: async (ctx, input: { project_id: string }): Promise<ToolResult> => {
    const run = await latestBuildRunForProject(asDb(ctx), asUser(ctx), input.project_id);
    if (!run) return { ok: true, data: { run: null }, message: "No build runs yet for this project." };
    return { ok: true, data: { run } };
  },
});

// --- devices (QORVYNA Connect + Jarvis Assistant) ---------------------------
toolRegistry.register({
  id: "devices.list",
  description: "List devices linked to the signed-in user's account via QORVYNA Connect QR pairing.",
  category: "devices",
  risk: RiskTier.LOW,
  requiredPermissions: [],
  scopes: ["devices:read"],
  environment: "server",
  timeoutSeconds: 15,
  approvalRequired: false,
  auditRequired: false,
  rateLimitPerMinute: 30,
  modelCallable: true,
  inputSchema: z.object({}),
  handler: async (ctx): Promise<ToolResult> => {
    const devices = await listDevices(asDb(ctx), ctx.uid);
    return { ok: true, data: { devices }, message: `${devices.length} linked device(s).` };
  },
});

toolRegistry.register({
  id: "device.status",
  description: "Read online status, last activity, OS, and permissions of the user's paired devices.",
  category: "devices",
  risk: RiskTier.LOW,
  requiredPermissions: [],
  scopes: ["devices:read"],
  environment: "server",
  timeoutSeconds: 15,
  approvalRequired: false,
  auditRequired: false,
  rateLimitPerMinute: 30,
  modelCallable: true,
  inputSchema: z.object({ device_id: z.string().max(128).optional() }),
  handler: async (ctx, input: { device_id?: string }): Promise<ToolResult> => {
    const devices = await listHubDevices(asDb(ctx), asUser(ctx));
    const filtered = input.device_id ? devices.filter((d) => d.id === input.device_id) : devices;
    if (input.device_id && filtered.length === 0) {
      return { ok: false, error: "DEVICE_NOT_FOUND", message: "Device was not found or has been revoked." };
    }
    return {
      ok: true,
      data: {
        devices: filtered.map((d) => ({
          id: d.id,
          name: d.device_name,
          type: d.device_type,
          platform: d.platform,
          os: d.os,
          app_version: d.app_version,
          status: d.status,
          last_active_at: d.last_active_at,
          permissions: d.permissions,
        })),
      },
      message: `${filtered.length} device(s) checked.`,
    };
  },
});

toolRegistry.register({
  id: "device.open_app",
  description: "Queue an approved request to open an application on a paired Android or Windows device.",
  category: "devices",
  risk: RiskTier.MEDIUM,
  requiredPermissions: [],
  scopes: ["devices:control"],
  environment: "device",
  timeoutSeconds: 15,
  approvalRequired: true,
  auditRequired: true,
  rateLimitPerMinute: 15,
  modelCallable: false,
  inputSchema: z.object({
    target_device_id: z.string().min(1).max(128),
    app_name: z.string().min(1).max(80),
  }),
  handler: async (ctx, input: { target_device_id: string; app_name: string }): Promise<ToolResult> => {
    const res = await queueDeviceCommand(asDb(ctx), asUser(ctx), {
      target_device_id: input.target_device_id,
      command: "open_app",
      args: { app_name: input.app_name },
      requires_confirmation: true,
    });
    return { ok: true, data: res, message: `Queued open_app("${input.app_name}") for device ${input.target_device_id}.` };
  },
});

toolRegistry.register({
  id: "device.media_control",
  description: "Queue an approved media playback/volume command (play_pause, next, previous, volume_up, volume_down, mute) on a paired device.",
  category: "devices",
  risk: RiskTier.MEDIUM,
  requiredPermissions: [],
  scopes: ["devices:control"],
  environment: "device",
  timeoutSeconds: 15,
  approvalRequired: true,
  auditRequired: true,
  rateLimitPerMinute: 20,
  modelCallable: false,
  inputSchema: z.object({
    target_device_id: z.string().min(1).max(128),
    action: z.enum(["play_pause", "next", "previous", "volume_up", "volume_down", "mute"]),
  }),
  handler: async (ctx, input: { target_device_id: string; action: string }): Promise<ToolResult> => {
    const res = await queueDeviceCommand(asDb(ctx), asUser(ctx), {
      target_device_id: input.target_device_id,
      command: "media_control",
      args: { action: input.action },
      requires_confirmation: true,
    });
    return { ok: true, data: res, message: `Queued media_control(${input.action}) for device ${input.target_device_id}.` };
  },
});

// --- reminders (Jarvis Voice Assistant) --------------------------------------
toolRegistry.register({
  id: "reminders.list",
  description: "List the signed-in user's saved reminders.",
  category: "voice",
  risk: RiskTier.LOW,
  requiredPermissions: [],
  scopes: ["devices:read"],
  environment: "server",
  timeoutSeconds: 10,
  approvalRequired: false,
  auditRequired: false,
  rateLimitPerMinute: 30,
  modelCallable: true,
  inputSchema: z.object({}),
  handler: async (ctx): Promise<ToolResult> => {
    const reminders = await listReminders(asDb(ctx), asUser(ctx));
    return { ok: true, data: { reminders }, message: `${reminders.length} reminder(s).` };
  },
});

toolRegistry.register({
  id: "reminders.create",
  description: "Create a personal reminder for the signed-in user.",
  category: "voice",
  risk: RiskTier.LOW,
  requiredPermissions: [],
  scopes: ["notifications:write"],
  environment: "server",
  timeoutSeconds: 10,
  approvalRequired: false,
  auditRequired: true,
  rateLimitPerMinute: 20,
  modelCallable: true,
  inputSchema: z.object({
    title: z.string().min(1).max(160),
    due_at: z.string().max(64).optional(),
    note: z.string().max(400).optional(),
  }),
  handler: async (ctx, input: { title: string; due_at?: string; note?: string }): Promise<ToolResult> => {
    const reminder = await createReminder(asDb(ctx), asUser(ctx), input);
    return { ok: true, data: { reminder }, message: `Reminder saved: ${reminder.title}` };
  },
});

// --- family -------------------------------------------------------------------
toolRegistry.register({
  id: "family.list",
  description: "List families the signed-in user belongs to, with the user's role in each.",
  category: "family",
  risk: RiskTier.LOW,
  requiredPermissions: [],
  scopes: ["family:read"],
  environment: "server",
  timeoutSeconds: 15,
  approvalRequired: false,
  auditRequired: false,
  rateLimitPerMinute: 30,
  modelCallable: true,
  inputSchema: z.object({}),
  handler: async (ctx): Promise<ToolResult> => {
    const families = await listFamiliesForUser(asDb(ctx), ctx.uid);
    return { ok: true, data: { families } };
  },
});

// --- notifications (Ecosystem + Sync) -----------------------------------------
toolRegistry.register({
  id: "notifications.create",
  description: "Create an in-app notification for the current user. This is not a push/email delivery claim.",
  category: "notifications",
  risk: RiskTier.LOW,
  requiredPermissions: [],
  scopes: ["notifications:write"],
  environment: "server",
  timeoutSeconds: 10,
  approvalRequired: false,
  auditRequired: true,
  rateLimitPerMinute: 30,
  inputSchema: z.object({
    title: z.string().min(1).max(120),
    body: z.string().max(1000).default(""),
    link: z.string().max(300).regex(/^\/(?!\/)/).default("/automations"),
  }),
  handler: async (ctx, raw): Promise<ToolResult> => {
    const input = raw as { title: string; body: string; link: string };
    const ref = await asDb(ctx).collection("notifications").add({
      user_id: ctx.uid,
      type: "automation",
      title: input.title,
      body: input.body,
      link: input.link,
      read_at: null,
      delivery_channel: "in_app",
      created_at: new Date(),
    });
    return { ok: true, data: { notification_id: ref.id, channel: "in_app" }, message: "In-app notification saved." };
  },
});

toolRegistry.register({
  id: "notifications.list_synced",
  description: "List cross-device synced notifications respecting app exclusions and privacy settings.",
  category: "notifications",
  risk: RiskTier.LOW,
  requiredPermissions: [],
  scopes: ["notifications:read"],
  environment: "server",
  timeoutSeconds: 15,
  approvalRequired: false,
  auditRequired: false,
  rateLimitPerMinute: 30,
  modelCallable: true,
  inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(25) }),
  handler: async (ctx, input: { limit: number }): Promise<ToolResult> => {
    const res = await listSyncedNotifications(asDb(ctx), asUser(ctx), { limit: input.limit });
    return {
      ok: true,
      data: { unread_count: res.unread_count, notifications: res.items, privacy_mode: res.preferences.privacy_mode },
      message: `${res.items.length} synced notification(s) (${res.unread_count} unread).`,
    };
  },
});

toolRegistry.register({
  id: "notifications.dismiss",
  description: "Dismiss a synced notification (and queue native dismissal on Android if applicable).",
  category: "notifications",
  risk: RiskTier.MEDIUM,
  requiredPermissions: [],
  scopes: ["notifications:write"],
  environment: "server",
  timeoutSeconds: 15,
  approvalRequired: true,
  auditRequired: true,
  rateLimitPerMinute: 20,
  modelCallable: false,
  inputSchema: z.object({ notification_id: z.string().min(1).max(128) }),
  handler: async (ctx, input: { notification_id: string }): Promise<ToolResult> => {
    const res = await dismissSyncedNotification(asDb(ctx), asUser(ctx), { id: input.notification_id });
    return { ok: true, data: res, message: res.status === "pending_approval" ? "Held for parent approval." : "Notification dismissed." };
  },
});

toolRegistry.register({
  id: "notifications.clear_history",
  description: "Clear non-protected synced notification history for the signed-in user.",
  category: "notifications",
  risk: RiskTier.HIGH,
  requiredPermissions: [],
  scopes: ["notifications:write"],
  environment: "server",
  timeoutSeconds: 15,
  approvalRequired: true,
  auditRequired: true,
  rateLimitPerMinute: 10,
  modelCallable: false,
  inputSchema: z.object({}),
  handler: async (ctx): Promise<ToolResult> => {
    const res = await clearSyncedNotificationHistory(asDb(ctx), asUser(ctx));
    return { ok: true, data: res, message: `Cleared ${res.cleared} notification(s).` };
  },
});
