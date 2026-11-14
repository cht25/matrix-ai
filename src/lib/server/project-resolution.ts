import "server-only";
import type { Db } from "@/lib/firebase/admin";
import type { SessionUser } from "@/lib/firebase/session";
import { RpcError } from "@/lib/server/errors";

const EDIT = /\b(?:edit|update|change|modify|fix|repair|refactor|rename|remove|redesign|improve)\b/i;
const EDIT_START = /^\s*(?:please\s+)?(?:edit|update|change|modify|fix|repair|refactor|rename|remove|redesign|improve|add\s+(?:a|an|the)\s+(?:section|feature|button|form|navbar)|make\s+(?:the|it|this)\s+)/i;
const NEW = /\b(?:create|build|start|make|scaffold|develop)\b[\s\S]{0,70}\b(?:new|another|separate|different)\s+(?:project|website|web\s?site|site|app|application|portfolio|dashboard|store|shop|blog|game)\b/i;
const CREATION_TARGET = /\b(?:website|web\s?site|site|app|application|project|portfolio|dashboard|store|shop|blog|game|landing\s+page)\b/i;
const FRESH_ARTIFACT = /\b(?:create|build|start|make|scaffold|develop)\s+(?:me\s+)?(?:a|an)\s+(?:\w+\s+){0,3}(?:website|web\s?site|site|app|application|project|portfolio|dashboard|store|shop|blog|game)\b/i;

/** A request that starts by asking for something to be made is a creation
 * request even when it names no "website/app" noun ("build a calculator"). */
const CREATE_START = /^\s*(?:please\s+|can you\s+|could you\s+|i (?:want|need)(?: you)? to\s+)?(?:create|build|generate|make\s+(?:me\s+)?(?:a|an)\b|design\s+(?:me\s+)?(?:a|an)\b|develop|scaffold|write\s+(?:me\s+)?(?:a|an)\b|code\s+(?:me\s+)?(?:a|an)\b)|^\s*(?:একটি|একটা)\b|(?:তৈরি|বানাও|বানিয়ে)/i;
/** Titles made only of generic words would "match" almost any prompt. */
const GENERIC_TITLE = /^(?:(?:my|new|the|a|an|untitled|matrix|test|demo|simple|first)\s+)*(?:website|web\s?site|site|app|application|project|portfolio|dashboard|store|shop|blog|game|landing\s+page|page|home)$/i;

function updatedMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (value && typeof value === "object" && typeof (value as { toMillis?: () => number }).toMillis === "function") return (value as { toMillis: () => number }).toMillis();
  if (typeof value === "number") return value;
  if (typeof value === "string") { const t = Date.parse(value); return Number.isFinite(t) ? t : 0; }
  return 0;
}

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
    return (title.length >= 4 && !GENERIC_TITLE.test(title) && new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, "iu").test(prompt)) ||
      new RegExp(`\\bproject(?:\\s+id)?\\s*[:#]?\\s*${doc.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(prompt);
  });
  const candidates = referenced.length ? referenced : legacyIds.length > 1 && EDIT_START.test(prompt)
    ? mine.filter((doc) => legacyIds.includes(doc.id)) : [];
  if (candidates.length === 1) return select(candidates[0].id, "reference");
  if (candidates.length > 1) {
    // Resolve what can be resolved before interrupting the user:
    //  • "Acme Store Admin" also contains the title "Acme Store" — the most
    //    specific (longest) matching title is the one that was named;
    //  • several projects created from THIS chat with no binding (legacy
    //    data) — the user is continuing the latest one.
    if (referenced.length) {
      const byLength = [...candidates].sort((a, b) => String(b.data().title ?? "").trim().length - String(a.data().title ?? "").trim().length);
      const longest = String(byLength[0].data().title ?? "").trim();
      const second = String(byLength[1].data().title ?? "").trim();
      if (longest.length > second.length && longest.toLowerCase().includes(second.toLowerCase())) return select(byLength[0].id, "reference");
    } else {
      const byRecency = [...candidates].sort((a, b) => updatedMillis(b.data().updated_at) - updatedMillis(a.data().updated_at));
      if (updatedMillis(byRecency[0].data().updated_at) > updatedMillis(byRecency[1].data().updated_at)) return select(byRecency[0].id, "legacy-chat");
    }
    const names = candidates.slice(0, 5).map((doc) => `${String(doc.data().title ?? "Untitled project").slice(0, 45)} (${doc.id})`);
    throw new RpcError("PROJECT_AMBIGUOUS", 409, `More than one of your projects matches: ${names.join(", ")}${candidates.length > 5 ? `, and ${candidates.length - 5} more` : ""}. Select one of your projects below and retry.`);
  }
  const isEdit = EDIT_START.test(prompt) || (EDIT.test(prompt) && !FRESH_ARTIFACT.test(prompt));
  // An edit with nothing bound, for a user who owns exactly one project, can
  // only mean that project. Asking them to pick from a list of one is noise.
  if (isEdit && mine.length === 1) return select(mine[0].id, "reference");
  // "Build it" / "create that" point at something that already exists; they
  // are not a description of a new project.
  const pronounOnly = /^\s*(?:please\s+)?(?:create|build|generate|make|develop|deploy|publish|ship)\s+(?:it|this|that|them|these|those)\b[\s.!?]*$/i.test(prompt);
  if (isEdit || pronounOnly || (!CREATION_TARGET.test(prompt) && !CREATE_START.test(prompt) && !input.hasAttachments)) {
    throw new RpcError("PROJECT_CONTEXT_MISSING", 409, mine.length
      ? "No project is associated with this chat. Open the project in Workspace or choose it by name before editing."
      : "You have no projects yet. Describe what to create and MATRIX will make a new one.");
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
