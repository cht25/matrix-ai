// =============================================================================
// MATRIX AI — registered tools. Each handler is a thin, ownership-checked
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
import { listFamiliesForUser } from "@/lib/server/family";

function asDb(ctx: ToolContext): Db {
  return ctx.db as Db;
}
function asUser(ctx: ToolContext): SessionUser {
  return { uid: ctx.uid, email: ctx.email, emailVerified: true };
}

// --- projects ---------------------------------------------------------------
toolRegistry.register({
  id: "projects.list",
  description: "List the signed-in user's own MATRIX projects.",
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

// --- devices (MATRIX Connect) -------------------------------------------------
toolRegistry.register({
  id: "devices.list",
  description: "List devices linked to the signed-in user's account via MATRIX Connect QR pairing.",
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


// A real, owner-scoped side effect usable in an explicitly created automation.
toolRegistry.register({
  id: "notifications.create",
  description: "Create an in-app notification for the current user. This is not a push/email delivery claim.",
  category: "notifications", risk: RiskTier.LOW, requiredPermissions: [], scopes: ["notifications:write"],
  environment: "server", timeoutSeconds: 10, approvalRequired: false, auditRequired: true, rateLimitPerMinute: 30,
  inputSchema: z.object({ title: z.string().min(1).max(120), body: z.string().max(1000).default(""), link: z.string().max(300).regex(/^\/(?!\/)/).default("/automations") }),
  handler: async (ctx, raw): Promise<ToolResult> => {
    const input = raw as { title: string; body: string; link: string };
    const ref = await asDb(ctx).collection("notifications").add({ user_id: ctx.uid, type: "automation", title: input.title, body: input.body, link: input.link, read_at: null, delivery_channel: "in_app", created_at: new Date() });
    return { ok: true, data: { notification_id: ref.id, channel: "in_app" }, message: "In-app notification saved." };
  },
});
