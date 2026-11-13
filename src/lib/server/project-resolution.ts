import "server-only";
import type { Db } from "@/lib/firebase/admin";
import type { SessionUser } from "@/lib/firebase/session";
import { RpcError } from "@/lib/server/errors";

const EDIT = /\b(?:edit|update|change|modify|fix|repair|refactor|rename|remove|redesign|improve)\b/i;
const EDIT_START = /^\s*(?:please\s+)?(?:edit|update|change|modify|fix|repair|refactor|rename|remove|redesign|improve|add\s+(?:a|an|the)\s+(?:section|feature|button|form|navbar)|make\s+(?:the|it|this)\s+)/i;
const NEW = /\b(?:create|build|start|make|scaffold|develop)\b[\s\S]{0,70}\b(?:new|another|separate|different)\s+(?:project|website|web\s?site|site|app|application|portfolio|dashboard|store|shop|blog|game)\b/i;
const CREATION_TARGET = /\b(?:website|web\s?site|site|app|application|project|portfolio|dashboard|store|shop|blog|game|landing\s+page)\b/i;
const FRESH_ARTIFACT = /\b(?:create|build|start|make|scaffold|develop)\s+(?:me\s+)?(?:a|an)\s+(?:\w+\s+){0,3}(?:website|web\s?site|site|app|application|project|portfolio|dashboard|store|shop|blog|game)\b/i;

export function wantsNewProject(prompt: string): boolean {
  return NEW.test(prompt);
}

export type ProjectResolution = { projectId: string | null; mode: "create" | "edit"; source: "explicit" | "workspace" | "chat" | "legacy-chat" | "reference" | "new"; forceNew?: boolean };

/** All candidate queries are owner-scoped. Never include another user's title
 * or ID in diagnostics, even when a caller supplies a guessed project ID. */
export async function resolveProjectContext(
  d: Db, user: SessionUser,
  input: { projectId?: string | null; workspaceProjectId?: string | null; conversationId?: string | null; prompt: string; hasAttachments?: boolean },
): Promise<ProjectResolution> {
  const { prompt } = input;
  const explicitNew = wantsNewProject(prompt);
  const select = async (id: string, source: ProjectResolution["source"]): Promise<ProjectResolution> => {
    const snap = await d.collection("projects").doc(id).get();
    if (!snap.exists || snap.data()?.owner_id !== user.uid || snap.data()?.archived_at) throw new RpcError("PROJECT_NOT_FOUND", 404, "That project does not exist or is not accessible. Select a project you own.");
    return { projectId: id, mode: "edit", source };
  };
  // Explicit user-supplied ID takes priority over the workspace. The client
  // passes an open workspace separately from an explicit project selection.
  if (input.projectId) return select(input.projectId, "explicit");
  const namedId = prompt.match(/\bproject\s+id\s*[:#]?\s*([A-Za-z0-9_-]{2,128})\b/i)?.[1];
  if (namedId) return select(namedId, "explicit");
  if (explicitNew || (FRESH_ARTIFACT.test(prompt) && !/\b(?:existing|current|this|that|same|already)\b/i.test(prompt))) {
    // Capture the binding BEFORE project creation. Computing this later races
    // with another first-build request that bound the same chat meanwhile.
    const chat = input.conversationId ? await d.collection("conversations").doc(input.conversationId).get() : null;
    if (chat && (!chat.exists || chat.data()?.user_id !== user.uid || chat.data()?.deleted_at)) {
      throw new RpcError("PROJECT_CONTEXT_MISSING", 409, "This chat is not accessible. Open a chat you own.");
    }
    return { projectId: null, mode: "create", source: "new",
      forceNew: explicitNew || Boolean(input.workspaceProjectId || chat?.data()?.active_project_id) };
  }
  if (input.workspaceProjectId) return select(input.workspaceProjectId, "workspace");

  let legacyIds: string[] = [];
  if (input.conversationId) {
    const conversation = await d.collection("conversations").doc(input.conversationId).get();
    if (!conversation.exists || conversation.data()?.user_id !== user.uid || conversation.data()?.deleted_at) {
      throw new RpcError("PROJECT_CONTEXT_MISSING", 409, "This chat is no longer available. Open a chat you own or start a new one.");
    }
    const active = conversation.data()?.active_project_id;
    if (typeof active === "string" && active) return select(active, "chat");
    // Legacy backfill only: projects used to be tagged with a chat but the
    // chat itself was not bound. Never choose the first of several results.
    const linked = await d.collection("projects").where("conversation_id", "==", input.conversationId).get();
    legacyIds = linked.docs.filter((doc) => doc.data().owner_id === user.uid && !doc.data().archived_at).map((doc) => doc.id);
    if (legacyIds.length === 1) return select(legacyIds[0], "legacy-chat");
  }

  // References are complete titles or explicit IDs, not fuzzy substring guesses.
  const projects = await d.collection("projects").where("owner_id", "==", user.uid).get();
  const mine = projects.docs.filter((doc) => !doc.data().archived_at);
  const referenced = mine.filter((doc) => {
    const title = typeof doc.data().title === "string" ? doc.data().title.trim() : "";
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return (title.length >= 4 && new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, "iu").test(prompt)) ||
      new RegExp(`\\bproject(?:\\s+id)?\\s*[:#]?\\s*${doc.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(prompt);
  });
  const candidates = referenced.length ? referenced : legacyIds.length > 1 && EDIT_START.test(prompt)
    ? mine.filter((doc) => legacyIds.includes(doc.id)) : [];
  if (candidates.length === 1) return select(candidates[0].id, "reference");
  if (candidates.length > 1) {
    const names = candidates.slice(0, 5).map((doc) => `${String(doc.data().title ?? "Untitled project").slice(0, 45)} (${doc.id})`);
    throw new RpcError("PROJECT_AMBIGUOUS", 409, `More than one of your projects matches: ${names.join(", ")}${candidates.length > 5 ? `, and ${candidates.length - 5} more` : ""}. Select one of your projects below and retry.`);
  }
  if (EDIT_START.test(prompt) || (EDIT.test(prompt) && !FRESH_ARTIFACT.test(prompt)) || (!CREATION_TARGET.test(prompt) && !input.hasAttachments)) {
    throw new RpcError("PROJECT_CONTEXT_MISSING", 409, "No project is associated with this chat. Open the project in Workspace or choose it by name before editing.");
  }
  return { projectId: null, mode: "create", source: "new", forceNew: false };
}

/** Legacy callers retain the original shape; new build callers use the mode. */
export async function resolveAgentProject(
  d: Db, user: SessionUser,
  input: { projectId?: string | null; conversationId?: string | null; prompt: string },
): Promise<string | null> {
  return (await resolveProjectContext(d, user, input)).projectId;
}

/** Keep the chat's durable pointer in step with actual source/deployment state.
 * No write is made unless BOTH the chat and project belong to the caller. */
export async function bindConversationProject(d: Db, user: SessionUser, conversationId: string, projectId: string) {
  const chatRef = d.collection("conversations").doc(conversationId);
  const projectRef = d.collection("projects").doc(projectId);
  await d.runTransaction(async (tx) => {
    const chat = await tx.get(chatRef);
    const project = await tx.get(projectRef);
    if (!chat.exists || chat.data()?.user_id !== user.uid || chat.data()?.deleted_at) throw new RpcError("PROJECT_CONTEXT_MISSING", 409);
    if (!project.exists || project.data()?.owner_id !== user.uid || project.data()?.archived_at) throw new RpcError("PROJECT_NOT_FOUND", 404);
    tx.set(chatRef, {
      active_project_id: projectId, project_owner_id: user.uid,
      active_source_revision: Number(project.data()?.revision ?? 0),
      current_deployment_id: project.data()?.live_deployment_id ?? null,
      project_last_activity_at: new Date(), updated_at: new Date(),
    }, { merge: true });
  });
}
